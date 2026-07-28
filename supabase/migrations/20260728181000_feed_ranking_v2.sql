-- Feed ranking v2: format-aware watch signals, seen suppression, capped creator
-- priors, and posterior-driven exploration.
--
-- v1 stays intact and active. Everything here is additive:
--
-- 1. post_feed_stats gains fact-derived, FORMAT-AWARE engagement columns. v1's
--    event-derived columns are untouched, so the active ranker cannot shift.
--    Denominators are per-format and per-delivery, fixing v1's mixing of feed
--    impressions, opened reels, images, and videos in one rate:
--      video    → depth = half-completions / video starts (a rendered video
--                 delivery IS a start, so zero-progress swipes count against it)
--      image/text → depth = 3s-dwell deliveries / rendered deliveries
--    A quick_skip fires INSTEAD of an impression, so v1's quick_skip_rate had a
--    denominator that structurally excluded its own numerator; rendered
--    deliveries are the honest denominator and are used for every new rate.
-- 2. creator_feed_stats: a creator-level quality rate, exposed to ranking only
--    through an explicitly capped feature (rich-get-richer guard).
-- 3. get_ranked_feed_candidates_v2: returns the per-pool-bounded candidate union
--    UNRANKED and UNTRUNCATED by any hard-coded weighting. v1 ordered by
--    hard-coded weights and cut to 300 before TypeScript ever saw the rows,
--    which made a differently-weighted experiment untestable. Pool sizes are
--    parameters, so retrieval_config finally drives retrieval.
-- 4. Seen suppression inputs: the viewer's recent qualified impressions are
--    collected once per request and returned as flags; TypeScript owns the
--    strict-unseen-first policy and the penalty fallback.
-- 5. refresh_user_interest_weights gains creation signals (successful
--    generations, weighted higher when template-driven) and the onboarding
--    goal seed, both normalized into post-space dimension values.
-- 6. for-you-rules v2 is inserted as 'shadow'. Nothing serves it until it is
--    activated or referenced by an experiment variant.

ALTER TABLE public.post_feed_stats
  ADD COLUMN IF NOT EXISTS served_delivery_count bigint NOT NULL DEFAULT 0
    CHECK (served_delivery_count >= 0),
  ADD COLUMN IF NOT EXISTS rendered_count bigint NOT NULL DEFAULT 0
    CHECK (rendered_count >= 0),
  ADD COLUMN IF NOT EXISTS video_start_count bigint NOT NULL DEFAULT 0
    CHECK (video_start_count >= 0),
  ADD COLUMN IF NOT EXISTS video_half_completion_count bigint NOT NULL DEFAULT 0
    CHECK (video_half_completion_count >= 0),
  ADD COLUMN IF NOT EXISTS video_completion_count bigint NOT NULL DEFAULT 0
    CHECK (video_completion_count >= 0),
  ADD COLUMN IF NOT EXISTS attention_ms_total bigint NOT NULL DEFAULT 0
    CHECK (attention_ms_total >= 0),
  ADD COLUMN IF NOT EXISTS attention_delivery_count bigint NOT NULL DEFAULT 0
    CHECK (attention_delivery_count >= 0),
  ADD COLUMN IF NOT EXISTS meaningful_engagement_count bigint NOT NULL DEFAULT 0
    CHECK (meaningful_engagement_count >= 0),
  ADD COLUMN IF NOT EXISTS quick_skip_delivery_count bigint NOT NULL DEFAULT 0
    CHECK (quick_skip_delivery_count >= 0),
  ADD COLUMN IF NOT EXISTS exploration_delivery_count bigint NOT NULL DEFAULT 0
    CHECK (exploration_delivery_count >= 0),
  ADD COLUMN IF NOT EXISTS exploration_success_count bigint NOT NULL DEFAULT 0
    CHECK (exploration_success_count >= 0),
  ADD COLUMN IF NOT EXISTS engagement_depth double precision NOT NULL DEFAULT 0
    CHECK (
      engagement_depth BETWEEN 0 AND 1
      AND engagement_depth <> 'NaN'::double precision
    ),
  ADD COLUMN IF NOT EXISTS attention_seconds_norm double precision NOT NULL DEFAULT 0
    CHECK (
      attention_seconds_norm BETWEEN 0 AND 1
      AND attention_seconds_norm <> 'NaN'::double precision
    ),
  ADD COLUMN IF NOT EXISTS meaningful_engagement_rate double precision NOT NULL DEFAULT 0
    CHECK (
      meaningful_engagement_rate BETWEEN 0 AND 1
      AND meaningful_engagement_rate <> 'NaN'::double precision
    );

COMMENT ON COLUMN public.post_feed_stats.engagement_depth IS
  'Format-aware depth: video half-completions per video start, otherwise 3s-dwell deliveries per rendered delivery.';
COMMENT ON COLUMN public.post_feed_stats.meaningful_engagement_rate IS
  'Bayesian rate of the binary meaningful-engagement reward over RENDERED deliveries; never-rendered deliveries are excluded, not failures.';

CREATE TABLE IF NOT EXISTS public.creator_feed_stats (
  creator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_key text NOT NULL CHECK (window_key IN ('24h', '7d', '30d')),
  rendered_count bigint NOT NULL DEFAULT 0 CHECK (rendered_count >= 0),
  meaningful_engagement_count bigint NOT NULL DEFAULT 0
    CHECK (meaningful_engagement_count >= 0),
  post_count bigint NOT NULL DEFAULT 0 CHECK (post_count >= 0),
  quality_rate double precision NOT NULL DEFAULT 0
    CHECK (
      quality_rate BETWEEN 0 AND 1
      AND quality_rate <> 'NaN'::double precision
    ),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (creator_user_id, window_key)
);

CREATE INDEX IF NOT EXISTS creator_feed_stats_window_quality_idx
  ON public.creator_feed_stats (window_key, quality_rate DESC, creator_user_id);

ALTER TABLE public.creator_feed_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.creator_feed_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.creator_feed_stats TO service_role;

CREATE POLICY "No client access to creator_feed_stats"
  ON public.creator_feed_stats FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.creator_feed_stats IS
  'Backend-owned creator quality aggregates; reaches ranking only through an explicitly capped feature.';

-- Three vocabularies meet here and none of them match:
--   posts.category                  image | video | text
--   generations.category            image | video | audio   (motion is a
--                                   creation_mode on a video, not a category)
--   onboarding goal                 image | video | motion
-- Interest weights are matched against POST columns, so an unnormalized value
-- writes a dimension that can never match a candidate — a silent dead weight
-- that looks like personalization and does nothing. Anything without a
-- post-space equivalent (audio) normalizes to NULL and is dropped rather than
-- stored.
CREATE OR REPLACE FUNCTION public.normalize_feed_interest_category(p_category text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE lower(btrim(coalesce(p_category, '')))
    WHEN 'image' THEN 'image'
    WHEN 'video' THEN 'video'
    WHEN 'motion' THEN 'video'
    WHEN 'ugc-ad' THEN 'video'
    WHEN 'ugc_ad' THEN 'video'
    WHEN 'text' THEN 'text'
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.normalize_feed_interest_category(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_feed_interest_category(text) TO service_role;

-- The binary exploration/quality reward, defined once so retrieval, post stats,
-- creator stats, and the scorecard can never drift apart.
--
--   success = video reached >= 50% relative completion
--          OR image/text held >= 3s of attention
--          OR save / remix start / resource open / purchase
--
-- Only ever evaluated over RENDERED deliveries: a delivery that was ranked but
-- never appeared on screen is excluded from the denominator, not counted as a
-- failure.
CREATE OR REPLACE FUNCTION public.is_meaningful_feed_engagement(
  p_category text,
  p_media_progress_max double precision,
  p_dwell_ms_max bigint,
  p_saved_at timestamptz,
  p_remix_started_at timestamptz,
  p_resource_opened_at timestamptz,
  p_purchased_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    (p_category = 'video' AND coalesce(p_media_progress_max, 0) >= 0.5)
    OR (coalesce(p_category, '') <> 'video' AND coalesce(p_dwell_ms_max, 0) >= 3000)
    OR p_saved_at IS NOT NULL
    OR p_remix_started_at IS NOT NULL
    OR p_resource_opened_at IS NOT NULL
    OR p_purchased_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz
) IS
  'Single source of truth for the binary meaningful-engagement reward over a rendered delivery.';

CREATE OR REPLACE FUNCTION public.refresh_creator_feed_stats(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Creator stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Creator stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_creator_feed_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_creators AS MATERIALIZED (
    SELECT facts.creator_user_id
    FROM public.feed_delivery_facts AS facts
    WHERE facts.creator_user_id IS NOT NULL
      AND facts.rendered_at IS NOT NULL
      AND facts.ranked_at >= p_as_of - interval '31 days'
      AND facts.ranked_at <= p_as_of
    GROUP BY facts.creator_user_id
    ORDER BY facts.creator_user_id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  rollup AS (
    SELECT
      candidates.creator_user_id,
      windows.window_key,
      count(facts.delivery_id)::bigint AS rendered_count,
      count(facts.delivery_id) FILTER (
        WHERE public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at
        )
      )::bigint AS meaningful_engagement_count,
      count(DISTINCT facts.post_id)::bigint AS post_count
    FROM candidate_creators AS candidates
    CROSS JOIN windows
    LEFT JOIN public.feed_delivery_facts AS facts
      ON facts.creator_user_id = candidates.creator_user_id
     AND facts.rendered_at IS NOT NULL
     AND facts.ranked_at >= p_as_of - windows.duration
     AND facts.ranked_at <= p_as_of
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    GROUP BY candidates.creator_user_id, windows.window_key
  )
  INSERT INTO public.creator_feed_stats (
    creator_user_id,
    window_key,
    rendered_count,
    meaningful_engagement_count,
    post_count,
    quality_rate,
    updated_at
  )
  SELECT
    rollup.creator_user_id,
    rollup.window_key,
    rollup.rendered_count,
    rollup.meaningful_engagement_count,
    rollup.post_count,
    -- Bayesian toward a modest global rate so a creator with two lucky
    -- deliveries cannot outrank a proven one.
    least(
      1.0::double precision,
      (rollup.meaningful_engagement_count::double precision + 3.0)
        / (rollup.rendered_count::double precision + 20.0)
    ),
    p_as_of
  FROM rollup
  ON CONFLICT (creator_user_id, window_key) DO UPDATE
  SET rendered_count = EXCLUDED.rendered_count,
      meaningful_engagement_count = EXCLUDED.meaningful_engagement_count,
      post_count = EXCLUDED.post_count,
      quality_rate = EXCLUDED.quality_rate,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer) IS
  'Refreshes bounded creator quality aggregates from durable delivery facts.';

-- Fact-derived, format-aware post aggregates. Kept in a SEPARATE function from
-- the v1 event rollup so the active v1 ranker's inputs cannot move while v2 is
-- being evaluated; feed maintenance calls both.
CREATE OR REPLACE FUNCTION public.refresh_post_feed_engagement_stats(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed engagement stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Feed engagement stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_post_feed_engagement_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_posts AS MATERIALIZED (
    SELECT facts.post_id
    FROM public.feed_delivery_facts AS facts
    WHERE facts.ranked_at >= p_as_of - interval '31 days'
      AND facts.ranked_at <= p_as_of
    GROUP BY facts.post_id
    ORDER BY facts.post_id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  rollup AS (
    SELECT
      candidates.post_id,
      windows.window_key,
      posts.category AS category,
      count(facts.delivery_id) FILTER (WHERE facts.served_at IS NOT NULL)::bigint
        AS served_delivery_count,
      count(facts.delivery_id) FILTER (WHERE facts.rendered_at IS NOT NULL)::bigint
        AS rendered_count,
      -- A rendered video delivery IS a start (the feed autoplays), so an
      -- instant swipe lands in the denominator instead of vanishing.
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND posts.category = 'video'
      )::bigint AS video_start_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND posts.category = 'video'
          AND facts.media_progress_max >= 0.5
      )::bigint AS video_half_completion_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND posts.category = 'video'
          AND facts.media_progress_max >= 0.95
      )::bigint AS video_completion_count,
      -- Attention milliseconds: watched fraction x duration for video, held
      -- dwell for everything else. Never mixed across formats.
      coalesce(sum(
        CASE
          WHEN facts.rendered_at IS NULL THEN 0
          WHEN posts.category = 'video'
            THEN least(
              facts.media_progress_max * coalesce(facts.media_duration_ms, 0)::double precision,
              3600000.0::double precision
            )
          ELSE least(facts.dwell_ms_max::double precision, 3600000.0::double precision)
        END
      ), 0.0::double precision)::bigint AS attention_ms_total,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND (posts.category <> 'video' OR facts.media_duration_ms IS NOT NULL)
      )::bigint AS attention_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND public.is_meaningful_feed_engagement(
            posts.category,
            facts.media_progress_max,
            facts.dwell_ms_max,
            facts.saved_at,
            facts.remix_started_at,
            facts.resource_opened_at,
            facts.purchased_at
          )
      )::bigint AS meaningful_engagement_count,
      -- v1 divided quick skips by impressions, but a quick skip fires INSTEAD
      -- of a qualified impression, so its own numerator was excluded from its
      -- denominator. Rendered deliveries fix that.
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND facts.quick_skipped_at IS NOT NULL
      )::bigint AS quick_skip_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND facts.is_exploration
      )::bigint AS exploration_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND facts.is_exploration
          AND public.is_meaningful_feed_engagement(
            posts.category,
            facts.media_progress_max,
            facts.dwell_ms_max,
            facts.saved_at,
            facts.remix_started_at,
            facts.resource_opened_at,
            facts.purchased_at
          )
      )::bigint AS exploration_success_count
    FROM candidate_posts AS candidates
    CROSS JOIN windows
    JOIN public.posts AS posts ON posts.id = candidates.post_id
    LEFT JOIN public.feed_delivery_facts AS facts
      ON facts.post_id = candidates.post_id
     AND facts.ranked_at >= p_as_of - windows.duration
     AND facts.ranked_at <= p_as_of
    GROUP BY candidates.post_id, windows.window_key, posts.category
  ),
  scored AS (
    SELECT
      rollup.*,
      CASE
        WHEN rollup.category = 'video' THEN least(
          1.0::double precision,
          (rollup.video_half_completion_count::double precision + 1.5)
            / (rollup.video_start_count::double precision + 6.0)
        )
        ELSE least(
          1.0::double precision,
          (rollup.meaningful_engagement_count::double precision + 1.5)
            / (rollup.rendered_count::double precision + 6.0)
        )
      END AS engagement_depth,
      -- Saturating at ~20s of held attention: past that, more seconds say
      -- little about whether this was the right thing to recommend.
      CASE
        WHEN rollup.attention_delivery_count = 0 THEN 0.0::double precision
        ELSE least(
          1.0::double precision,
          1.0::double precision - exp(
            -1.0::double precision
            * (
              (rollup.attention_ms_total::double precision / 1000.0)
              / rollup.attention_delivery_count::double precision
            ) / 20.0::double precision
          )
        )
      END AS attention_seconds_norm,
      least(
        1.0::double precision,
        (rollup.meaningful_engagement_count::double precision + 2.0)
          / (rollup.rendered_count::double precision + 12.0)
      ) AS meaningful_engagement_rate
    FROM rollup
  )
  INSERT INTO public.post_feed_stats AS stats (
    post_id,
    window_key,
    served_delivery_count,
    rendered_count,
    video_start_count,
    video_half_completion_count,
    video_completion_count,
    attention_ms_total,
    attention_delivery_count,
    meaningful_engagement_count,
    quick_skip_delivery_count,
    exploration_delivery_count,
    exploration_success_count,
    engagement_depth,
    attention_seconds_norm,
    meaningful_engagement_rate,
    updated_at
  )
  SELECT
    scored.post_id,
    scored.window_key,
    scored.served_delivery_count,
    scored.rendered_count,
    scored.video_start_count,
    scored.video_half_completion_count,
    scored.video_completion_count,
    scored.attention_ms_total,
    scored.attention_delivery_count,
    scored.meaningful_engagement_count,
    scored.quick_skip_delivery_count,
    scored.exploration_delivery_count,
    scored.exploration_success_count,
    scored.engagement_depth,
    scored.attention_seconds_norm,
    scored.meaningful_engagement_rate,
    p_as_of
  FROM scored
  ON CONFLICT (post_id, window_key) DO UPDATE
  SET served_delivery_count = EXCLUDED.served_delivery_count,
      rendered_count = EXCLUDED.rendered_count,
      video_start_count = EXCLUDED.video_start_count,
      video_half_completion_count = EXCLUDED.video_half_completion_count,
      video_completion_count = EXCLUDED.video_completion_count,
      attention_ms_total = EXCLUDED.attention_ms_total,
      attention_delivery_count = EXCLUDED.attention_delivery_count,
      meaningful_engagement_count = EXCLUDED.meaningful_engagement_count,
      quick_skip_delivery_count = EXCLUDED.quick_skip_delivery_count,
      exploration_delivery_count = EXCLUDED.exploration_delivery_count,
      exploration_success_count = EXCLUDED.exploration_success_count,
      engagement_depth = EXCLUDED.engagement_depth,
      attention_seconds_norm = EXCLUDED.attention_seconds_norm,
      meaningful_engagement_rate = EXCLUDED.meaningful_engagement_rate,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer) IS
  'Refreshes format-aware watch and engagement aggregates from durable delivery facts.';

-- v2 candidate retrieval.
--
-- Differences from v1 that matter for experimentation:
--   * No hard-coded weighted ORDER BY and no global LIMIT. v1 ranked with
--     baked-in v1 weights and cut to 300 before TypeScript saw a row, so a
--     re-weighted variant could only reshuffle v1's picks. Here retrieval
--     returns the deduped per-pool union and TypeScript is the only scorer.
--   * Pool sizes are parameters, so retrieval_config actually drives retrieval.
--   * The viewer's recent qualified impressions are collected ONCE (bounded by
--     the viewer's own activity, not by catalog size) and every pool prefers
--     unseen rows. The seen flag and last-seen time are returned so the caller
--     can apply strict-unseen-first with a penalty fallback.
--   * Exploration is optimism under uncertainty (Bayesian UCB on the binary
--     meaningful-engagement posterior) rather than lowest-impressions-first.
--   * The creator prior is a separate, explicitly capped feature. It can never
--     become a multiplier on a post's own evidence, which is what turns a
--     creator prior into a rich-get-richer loop.
CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates_v2(
  p_viewer_user_id uuid DEFAULT NULL,
  p_anonymous_key_hash text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_following_limit integer DEFAULT 100,
  p_interest_limit integer DEFAULT 150,
  p_trending_limit integer DEFAULT 100,
  p_recent_limit integer DEFAULT 150,
  p_exploration_limit integer DEFAULT 100,
  p_seen_lookback_days integer DEFAULT 14,
  p_creator_prior_cap double precision DEFAULT 0.15,
  p_exploration_confidence double precision DEFAULT 1.5,
  p_as_of timestamptz DEFAULT timezone('utc'::text, now())
)
RETURNS TABLE (
  post_id uuid,
  interest_match double precision,
  creator_affinity double precision,
  smoothed_usefulness double precision,
  freshness double precision,
  relevant_trend double precision,
  exploration_bonus double precision,
  quick_skip_risk double precision,
  negative_feedback_risk double precision,
  engagement_depth double precision,
  attention_seconds_norm double precision,
  creator_quality double precision,
  exploration_ucb double precision,
  seen_recently boolean,
  last_seen_at timestamptz,
  candidate_source text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed candidate timestamp is required';
  END IF;

  IF p_following_limit IS NULL OR p_following_limit < 0 OR p_following_limit > 500
    OR p_interest_limit IS NULL OR p_interest_limit < 0 OR p_interest_limit > 500
    OR p_trending_limit IS NULL OR p_trending_limit < 0 OR p_trending_limit > 500
    OR p_recent_limit IS NULL OR p_recent_limit < 0 OR p_recent_limit > 500
    OR p_exploration_limit IS NULL OR p_exploration_limit < 0 OR p_exploration_limit > 500
  THEN
    RAISE EXCEPTION 'Feed candidate pool limits must be between 0 and 500';
  END IF;

  IF p_seen_lookback_days IS NULL OR p_seen_lookback_days < 0 OR p_seen_lookback_days > 365 THEN
    RAISE EXCEPTION 'Feed seen lookback days must be between 0 and 365';
  END IF;

  IF p_creator_prior_cap IS NULL OR p_creator_prior_cap < 0 OR p_creator_prior_cap > 1 THEN
    RAISE EXCEPTION 'Creator prior cap must be between 0 and 1';
  END IF;

  IF p_exploration_confidence IS NULL
    OR p_exploration_confidence < 0
    OR p_exploration_confidence > 5
  THEN
    RAISE EXCEPTION 'Exploration confidence must be between 0 and 5';
  END IF;

  RETURN QUERY
  WITH seen AS MATERIALIZED (
    -- One viewer-prefixed index range scan; cost tracks the viewer's own
    -- recent activity, never the size of the catalog.
    SELECT events.post_id, max(events.occurred_at) AS last_seen_at
    FROM public.feed_events AS events
    WHERE events.event_type = 'impression'
      AND p_seen_lookback_days > 0
      AND events.occurred_at >= p_as_of - make_interval(days => p_seen_lookback_days)
      AND (
        (p_viewer_user_id IS NOT NULL AND events.viewer_user_id = p_viewer_user_id)
        OR (
          p_viewer_user_id IS NULL
          AND p_anonymous_key_hash IS NOT NULL
          AND events.anonymous_key_hash = p_anonymous_key_hash
        )
      )
    GROUP BY events.post_id
  ),
  eligible AS MATERIALIZED (
    SELECT
      p.id,
      p.user_id AS creator_id,
      p.category,
      p.post_format,
      p.source_tool_slug,
      p.created_at,
      (seen.post_id IS NOT NULL) AS seen_recently,
      seen.last_seen_at
    FROM public.posts AS p
    LEFT JOIN seen ON seen.post_id = p.id
    WHERE p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
      AND (p_category IS NULL OR p.category = p_category)
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.feed_user_post_feedback AS post_feedback
          WHERE post_feedback.user_id = p_viewer_user_id
            AND post_feedback.post_id = p.id
            AND post_feedback.is_active = true
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.feed_user_creator_feedback AS creator_feedback
          WHERE creator_feedback.user_id = p_viewer_user_id
            AND creator_feedback.creator_user_id = p.user_id
            AND creator_feedback.is_active = true
        )
      )
  ),
  posterior AS (
    -- Beta(successes + 1, failures + 1) over rendered deliveries, 30d.
    SELECT
      e.id AS post_id,
      (coalesce(stats.meaningful_engagement_count, 0)::double precision + 1.0) AS alpha,
      (
        greatest(
          0.0::double precision,
          coalesce(stats.rendered_count, 0)::double precision
            - coalesce(stats.meaningful_engagement_count, 0)::double precision
        ) + 1.0
      ) AS beta
    FROM eligible AS e
    LEFT JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id AND stats.window_key = '30d'
  ),
  exploration_scores AS (
    SELECT
      posterior.post_id,
      least(
        1.0::double precision,
        greatest(
          0.0::double precision,
          (posterior.alpha / (posterior.alpha + posterior.beta))
          + p_exploration_confidence * sqrt(
            (posterior.alpha * posterior.beta)
            / (
              power(posterior.alpha + posterior.beta, 2.0::double precision)
              * (posterior.alpha + posterior.beta + 1.0)
            )
          )
        )
      ) AS exploration_ucb
    FROM posterior
  ),
  following_pool AS (
    SELECT e.id AS post_id, 'following'::text AS source, 1 AS source_priority
    FROM eligible AS e
    JOIN public.follows AS f
      ON f.following_id = e.creator_id
     AND f.follower_id = p_viewer_user_id
    WHERE p_viewer_user_id IS NOT NULL
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_following_limit
  ),
  interest_pool AS (
    SELECT e.id AS post_id, 'affinity'::text AS source, 2 AS source_priority
    FROM eligible AS e
    WHERE p_viewer_user_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.user_interest_weights AS interest
        WHERE interest.user_id = p_viewer_user_id
          AND interest.weight > 0
          AND (
            (interest.dimension_type = 'category' AND interest.dimension_value = e.category)
            OR (interest.dimension_type = 'media_type' AND interest.dimension_value IN (e.category, e.post_format))
            OR (interest.dimension_type = 'source_tool' AND interest.dimension_value = e.source_tool_slug)
            OR (interest.dimension_type = 'creator' AND interest.dimension_value = e.creator_id::text)
          )
      )
    ORDER BY e.seen_recently ASC, (
      SELECT max(interest.weight)
      FROM public.user_interest_weights AS interest
      WHERE interest.user_id = p_viewer_user_id
        AND interest.weight > 0
        AND (
          (interest.dimension_type = 'category' AND interest.dimension_value = e.category)
          OR (interest.dimension_type = 'media_type' AND interest.dimension_value IN (e.category, e.post_format))
          OR (interest.dimension_type = 'source_tool' AND interest.dimension_value = e.source_tool_slug)
          OR (interest.dimension_type = 'creator' AND interest.dimension_value = e.creator_id::text)
        )
    ) DESC NULLS LAST, e.created_at DESC, e.id DESC
    LIMIT p_interest_limit
  ),
  trending_pool AS (
    SELECT e.id AS post_id, 'trending'::text AS source, 3 AS source_priority
    FROM eligible AS e
    JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id
     AND stats.window_key = '24h'
    ORDER BY e.seen_recently ASC,
      stats.meaningful_engagement_rate DESC,
      stats.rendered_count DESC,
      e.created_at DESC,
      e.id DESC
    LIMIT p_trending_limit
  ),
  recent_pool AS (
    SELECT e.id AS post_id, 'fresh'::text AS source, 4 AS source_priority
    FROM eligible AS e
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_recent_limit
  ),
  exploration_pool AS (
    SELECT e.id AS post_id, 'exploration'::text AS source, 5 AS source_priority
    FROM eligible AS e
    JOIN exploration_scores AS scores ON scores.post_id = e.id
    ORDER BY e.seen_recently ASC, scores.exploration_ucb DESC, e.created_at DESC, e.id DESC
    LIMIT p_exploration_limit
  ),
  pooled AS (
    SELECT * FROM following_pool
    UNION ALL SELECT * FROM interest_pool
    UNION ALL SELECT * FROM trending_pool
    UNION ALL SELECT * FROM recent_pool
    UNION ALL SELECT * FROM exploration_pool
  ),
  deduplicated AS (
    SELECT DISTINCT ON (pool.post_id) pool.post_id, pool.source
    FROM pooled AS pool
    ORDER BY pool.post_id, pool.source_priority
  )
  SELECT
    e.id,
    least(1.0::double precision, greatest(0.0::double precision, coalesce(interest.value, 0)))
      AS interest_match,
    least(1.0::double precision, greatest(0.0::double precision, coalesce(affinity.value, 0)))
      AS creator_affinity,
    coalesce(stats_7d.usefulness_score, 0.08::double precision) AS smoothed_usefulness,
    least(
      1.0::double precision,
      power(
        0.5::double precision,
        greatest(0.0::double precision, extract(epoch FROM (p_as_of - e.created_at))::double precision)
          / 259200.0::double precision
      )
    ) AS freshness,
    least(
      1.0::double precision,
      greatest(
        0.0::double precision,
        coalesce(stats_24h.meaningful_engagement_rate, 0.0::double precision)
          * (
            ln(1.0::double precision + coalesce(stats_24h.rendered_count, 0)::double precision)
            / ln(101.0::double precision)
          )
      )
    ) AS relevant_trend,
    1.0::double precision
      / sqrt(1.0::double precision + coalesce(stats_30d.impression_count, 0)::double precision / 20.0::double precision)
      AS exploration_bonus,
    least(
      1.0::double precision,
      (coalesce(stats_7d.quick_skip_delivery_count, 0)::double precision + 1.0::double precision)
        / (coalesce(stats_7d.rendered_count, 0)::double precision + 8.0::double precision)
    ) AS quick_skip_risk,
    least(
      1.0::double precision,
      (
        coalesce(stats_7d.not_interested_count, 0)::double precision
        + coalesce(stats_7d.hide_creator_count, 0)::double precision
        + (2.0::double precision * coalesce(stats_7d.report_count, 0)::double precision)
        + 0.2::double precision
      ) / (coalesce(stats_7d.impression_count, 0)::double precision + 20.0::double precision)
    ) AS negative_feedback_risk,
    coalesce(stats_7d.engagement_depth, 0.25::double precision) AS engagement_depth,
    coalesce(stats_7d.attention_seconds_norm, 0.0::double precision) AS attention_seconds_norm,
    least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, 0.0::double precision))
      AS creator_quality,
    coalesce(scores.exploration_ucb, 0.0::double precision) AS exploration_ucb,
    e.seen_recently,
    e.last_seen_at,
    d.source
  FROM deduplicated AS d
  JOIN eligible AS e ON e.id = d.post_id
  LEFT JOIN exploration_scores AS scores ON scores.post_id = e.id
  LEFT JOIN public.post_feed_stats AS stats_24h
    ON stats_24h.post_id = e.id AND stats_24h.window_key = '24h'
  LEFT JOIN public.post_feed_stats AS stats_7d
    ON stats_7d.post_id = e.id AND stats_7d.window_key = '7d'
  LEFT JOIN public.post_feed_stats AS stats_30d
    ON stats_30d.post_id = e.id AND stats_30d.window_key = '30d'
  LEFT JOIN public.creator_feed_stats AS creator_stats
    ON creator_stats.creator_user_id = e.creator_id AND creator_stats.window_key = '30d'
  LEFT JOIN LATERAL (
    SELECT least(
      1.0::double precision,
      greatest(
        0.0::double precision,
        coalesce(sum(greatest(i.weight, 0.0::double precision)), 0.0::double precision)
          / 10.0::double precision
      )
    ) AS value
    FROM public.user_interest_weights AS i
    WHERE i.user_id = p_viewer_user_id
      AND (
        (i.dimension_type = 'category' AND i.dimension_value = e.category)
        OR (i.dimension_type = 'media_type' AND i.dimension_value IN (e.category, e.post_format))
        OR (i.dimension_type = 'source_tool' AND i.dimension_value = e.source_tool_slug)
      )
  ) AS interest ON true
  LEFT JOIN LATERAL (
    SELECT least(
      1.0::double precision,
      (
        CASE WHEN EXISTS (
          SELECT 1
          FROM public.follows AS f
          WHERE f.follower_id = p_viewer_user_id
            AND f.following_id = e.creator_id
        ) THEN 0.75::double precision ELSE 0.0::double precision END
      ) + greatest(
        0.0::double precision,
        coalesce((
          SELECT max(i.weight) / 10.0::double precision
          FROM public.user_interest_weights AS i
          WHERE i.user_id = p_viewer_user_id
            AND i.dimension_type = 'creator'
            AND i.dimension_value = e.creator_id::text
        ), 0.0::double precision)
      )
    ) AS value
  ) AS affinity ON true;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ranked_feed_candidates_v2(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ranked_feed_candidates_v2(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.get_ranked_feed_candidates_v2(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz
) IS
  'Returns the unranked per-pool candidate union with format-aware features, seen flags, capped creator prior, and UCB exploration; scoring belongs to the caller.';

-- Immediate cold-start seed from the goal onboarding already collects. Written
-- at goal-capture time so a brand-new account's first feed is not blind; the
-- refresh below re-derives the same seed so a rebuild cannot erase it.
-- GREATEST means a seed can only ever raise a weight, never overwrite real
-- behavioural signal with a stale intent.
CREATE OR REPLACE FUNCTION public.seed_user_interest_from_onboarding_goal(
  p_user_id uuid,
  p_goal text,
  p_weight double precision DEFAULT 4.0,
  p_as_of timestamptz DEFAULT timezone('utc'::text, now())
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category text;
  v_rows integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Interest seed requires a user';
  END IF;

  IF p_weight IS NULL OR p_weight <= 0 OR p_weight > 20 THEN
    RAISE EXCEPTION 'Interest seed weight must be between 0 and 20';
  END IF;

  v_category := public.normalize_feed_interest_category(p_goal);
  IF v_category IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.user_interest_weights AS weights (
    user_id, dimension_type, dimension_value, weight,
    positive_score, negative_score, positive_event_count, negative_event_count,
    last_event_at, last_event_received_at, updated_at
  )
  SELECT
    p_user_id, dimension_type, v_category, p_weight,
    p_weight, 0, 0, 0,
    p_as_of, p_as_of, p_as_of
  FROM (VALUES ('category'), ('media_type')) AS dimensions(dimension_type)
  ON CONFLICT (user_id, dimension_type, dimension_value) DO UPDATE
  SET weight = greatest(weights.weight, EXCLUDED.weight),
      positive_score = greatest(weights.positive_score, EXCLUDED.positive_score),
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_user_interest_from_onboarding_goal(
  uuid, text, double precision, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_user_interest_from_onboarding_goal(
  uuid, text, double precision, timestamptz
) TO service_role;

-- Interest refresh v2: what a user MAKES now feeds what they see.
--
-- v1 derived interests from feed events alone, which ignored the strongest
-- signal a creation product has. Successful generations (and the template runs
-- behind them) are added here, normalized into post-space category values so
-- the weights can actually match a candidate. source_tool is deliberately NOT
-- written from generations.model: the model vocabulary and posts.source_tool_slug
-- are different namespaces, and a dimension that can never match is worse than
-- no dimension at all.
CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_lookback_days integer DEFAULT 90,
  p_half_life_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Interest refresh timestamp is required';
  END IF;

  IF p_lookback_days IS NULL OR p_lookback_days < 1 OR p_lookback_days > 365 THEN
    RAISE EXCEPTION 'Interest lookback days must be between 1 and 365';
  END IF;

  IF p_half_life_days IS NULL OR p_half_life_days < 1 OR p_half_life_days > 365 THEN
    RAISE EXCEPTION 'Interest half-life days must be between 1 and 365';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Interest refresh limit must be between 1 and 5000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_user_interest_weights', 0)) THEN
    RETURN 0;
  END IF;

  SELECT array_agg(candidate.user_id ORDER BY candidate.last_refresh ASC NULLS FIRST, candidate.user_id)
  INTO v_user_ids
  FROM (
    SELECT
      active.user_id,
      min(interests.updated_at) AS last_refresh
    FROM (
      SELECT events.viewer_user_id AS user_id
      FROM public.feed_events AS events
      WHERE events.viewer_user_id IS NOT NULL
        -- Session pruning clears session_item_id after two days; the immutable
        -- delivery_fact_id keeps the full configured interest window usable.
        AND events.delivery_fact_id IS NOT NULL
        AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
        AND events.occurred_at <= p_as_of

      UNION

      -- Creators with recent successful generations are refreshed even with no
      -- feed activity at all, which is exactly the cold-start case.
      SELECT generations.user_id
      FROM public.generations AS generations
      WHERE generations.user_id IS NOT NULL
        AND generations.status = 'completed'
        AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
        AND generations.completed_at <= p_as_of
    ) AS active
    LEFT JOIN public.user_interest_weights AS interests
      ON interests.user_id = active.user_id
    GROUP BY active.user_id
    ORDER BY min(interests.updated_at) ASC NULLS FIRST, active.user_id
    LIMIT p_limit
  ) AS candidate;

  IF coalesce(cardinality(v_user_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  DELETE FROM public.user_interest_weights
  WHERE user_id = ANY(v_user_ids);

  WITH weighted_events AS (
    SELECT
      events.viewer_user_id AS user_id,
      posts.user_id AS creator_user_id,
      posts.category,
      posts.post_format,
      posts.source_tool_slug,
      events.occurred_at,
      events.received_at,
      (
        CASE events.event_type
          WHEN 'open' THEN 0.10::double precision
          WHEN 'dwell' THEN CASE
            WHEN coalesce(events.duration_ms::double precision, events.event_value, 0) >= 3000
              THEN 0.35::double precision
            ELSE 0.05::double precision
          END
          WHEN 'media_progress' THEN CASE
            WHEN coalesce(events.progress, events.event_value, 0) >= 0.75
              THEN 0.50::double precision
            ELSE 0.10::double precision
          END
          WHEN 'quick_skip' THEN -1.00::double precision
          WHEN 'save' THEN 3.00::double precision
          WHEN 'unsave' THEN -1.00::double precision
          WHEN 'share' THEN 2.00::double precision
          WHEN 'follow' THEN 4.00::double precision
          WHEN 'remix_start' THEN 4.00::double precision
          WHEN 'remix_complete' THEN 6.00::double precision
          WHEN 'resource_open' THEN 2.00::double precision
          WHEN 'purchase' THEN 8.00::double precision
          WHEN 'not_interested' THEN -6.00::double precision
          WHEN 'hide_creator' THEN -8.00::double precision
          WHEN 'report' THEN -10.00::double precision
          ELSE 0.00::double precision
        END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - events.occurred_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.feed_events AS events
    JOIN public.posts AS posts ON posts.id = events.post_id
    WHERE events.viewer_user_id = ANY(v_user_ids)
      AND events.delivery_fact_id IS NOT NULL
      AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
      AND events.occurred_at <= p_as_of
  ),
  weighted_creations AS (
    SELECT
      generations.user_id,
      public.normalize_feed_interest_category(generations.category) AS category,
      generations.completed_at AS occurred_at,
      (
        3.00::double precision
        + CASE WHEN generations.template_run_id IS NOT NULL THEN 1.00::double precision ELSE 0.00::double precision END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - generations.completed_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.generations AS generations
    LEFT JOIN public.template_runs AS runs ON runs.id = generations.template_run_id
    WHERE generations.user_id = ANY(v_user_ids)
      AND generations.status = 'completed'
      AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
      AND generations.completed_at <= p_as_of
      AND public.normalize_feed_interest_category(generations.category) IS NOT NULL
  ),
  onboarding_seeds AS (
    SELECT
      states.user_id,
      public.normalize_feed_interest_category(states.goal) AS category,
      coalesce(states.updated_at, states.created_at) AS occurred_at,
      4.00::double precision * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - coalesce(states.updated_at, states.created_at)))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.mobile_onboarding_states AS states
    WHERE states.user_id = ANY(v_user_ids)
      AND public.normalize_feed_interest_category(states.goal) IS NOT NULL
  ),
  dimensions AS (
    SELECT
      weighted.user_id,
      'category'::text AS dimension_type,
      weighted.category AS dimension_value,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.category IS NOT NULL AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'media_type'::text,
      coalesce(weighted.post_format, weighted.category),
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE coalesce(weighted.post_format, weighted.category) IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'source_tool'::text,
      weighted.source_tool_slug,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.source_tool_slug IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'creator'::text,
      weighted.creator_user_id::text,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'category'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'media_type'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'category'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'media_type'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0
  )
  INSERT INTO public.user_interest_weights (
    user_id,
    dimension_type,
    dimension_value,
    weight,
    positive_score,
    negative_score,
    positive_event_count,
    negative_event_count,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    dimensions.user_id,
    dimensions.dimension_type,
    dimensions.dimension_value,
    least(
      20.0::double precision,
      greatest(-20.0::double precision, sum(dimensions.signed_weight))
    ),
    sum(greatest(dimensions.signed_weight, 0.0::double precision)),
    sum(greatest(-dimensions.signed_weight, 0.0::double precision)),
    count(*) FILTER (WHERE dimensions.signed_weight > 0),
    count(*) FILTER (WHERE dimensions.signed_weight < 0),
    max(dimensions.occurred_at),
    max(dimensions.received_at),
    p_as_of
  FROM dimensions
  GROUP BY dimensions.user_id, dimensions.dimension_type, dimensions.dimension_value
  HAVING abs(sum(dimensions.signed_weight)) >= 0.01::double precision
  ON CONFLICT (user_id, dimension_type, dimension_value) DO UPDATE
  SET weight = EXCLUDED.weight,
      positive_score = EXCLUDED.positive_score,
      negative_score = EXCLUDED.negative_score,
      positive_event_count = EXCLUDED.positive_event_count,
      negative_event_count = EXCLUDED.negative_event_count,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at;

  RETURN cardinality(v_user_ids);
END;
$$;

COMMENT ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer) IS
  'Rebuilds bounded user-interest batches from feed behaviour, successful generations, and the onboarding goal, with exponential time decay.';

GRANT SELECT ON TABLE public.generations TO service_role;
GRANT SELECT ON TABLE public.template_runs TO service_role;
GRANT SELECT ON TABLE public.mobile_onboarding_states TO service_role;

-- for-you-rules v2, inserted as SHADOW: nothing serves it until it is either
-- activated or referenced by an experiment variant. Watch depth carries the
-- largest single positive weight, mirroring what every major short-video feed
-- reports as its strongest signal, while negative feedback keeps the largest
-- magnitude overall so engagement can never outvote an explicit "no".
INSERT INTO public.feed_algorithm_versions (
  algorithm_key,
  version,
  status,
  description,
  weights,
  retrieval_config,
  diversity_config
)
VALUES (
  'for-you-rules',
  2,
  'shadow',
  'Format-aware watch depth, strict unseen-first retrieval, capped creator prior, and UCB exploration.',
  jsonb_build_object(
    'interest_match', 0.26,
    'creator_affinity', 0.12,
    'smoothed_usefulness', 0.10,
    'engagement_depth', 0.24,
    'attention_seconds_norm', 0.08,
    'freshness', 0.12,
    'relevant_trend', 0.06,
    'creator_quality', 0.06,
    'exploration_ucb', 0.10,
    'exploration_bonus', 0.0,
    'quick_skip_risk', -0.30,
    'negative_feedback_risk', -0.80
  ),
  jsonb_build_object(
    'candidate_rpc', 'v2',
    'following_limit', 100,
    'interest_limit', 150,
    'trending_limit', 100,
    'recent_limit', 150,
    'exploration_limit', 100,
    'seen_lookback_days', 14,
    'seen_penalty', 0.2,
    'creator_prior_cap', 0.15,
    'exploration_confidence', 1.5,
    'session_item_limit', 60
  ),
  jsonb_build_object(
    'max_creator_per_20', 2,
    'max_semantic_cluster_per_20', 3,
    'exploration_per_10', 1,
    'max_paid_share', 0.20
  )
)
ON CONFLICT (algorithm_key, version) DO NOTHING;

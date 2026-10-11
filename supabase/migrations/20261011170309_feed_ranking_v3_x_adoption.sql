-- Feed ranking v3: what For You takes from X's algorithm
-- (docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md, section 2).
--
-- v1 stays active and v2 stays shadow. v3 is seeded 'shadow', so nothing serves
-- it until an operator activates it or an experiment variant references it.
-- Two changes DO reach the live ranker the moment this applies:
--
-- 1. creator_feed_stats gains a negative-feedback count and smoothed rate per
--    creator (not-interested / hide-creator deliveries plus two per report on
--    the creator's posts), filled by refresh_creator_feed_stats.
-- 2. refresh_post_feed_stats (v1's inputs) counts events by delivery_fact_id
--    instead of session_item_id. Sessions are pruned two days after expiry and
--    pruning nulls session_item_id, so every 7d and 30d window had quietly
--    collapsed to about two days. delivery_fact_id is stamped once and never
--    cleared; refresh_user_interest_weights already switched (20261005170739).
--
-- Everything else is additive:
--
-- 3. get_ranked_feed_candidates_v3: v2's retrieval plus a cold pool, a
--    projected-velocity trending pool capped per author, a bounded catalog
--    (p_max_age_days), served-but-unseen flags, NSFW / own-post / block /
--    viewer-report exclusions in SQL (before ranking and persistence), every
--    source a post came from, and the raw counts the cold-start slot needs.
--    Like v2 it returns the deduplicated pool union UNRANKED: no weight
--    appears in SQL, TypeScript is the only scorer.
-- 4. activate_feed_algorithm_version, create_feed_experiment,
--    set_feed_experiment_status: the first code path that can promote a
--    version (or roll back to a retired one) or start an experiment. Service
--    role only.
-- 5. feed_algorithm_scorecard: per version / variant / source outcome counts
--    over served delivery facts, plus an all-sources row per version and
--    variant. Service role only.
-- 6. for-you-rules v3, inserted as 'shadow'.

ALTER TABLE public.creator_feed_stats
  ADD COLUMN IF NOT EXISTS negative_feedback_count bigint NOT NULL DEFAULT 0
    CHECK (negative_feedback_count >= 0),
  ADD COLUMN IF NOT EXISTS negative_feedback_rate double precision NOT NULL DEFAULT 0
    CHECK (
      negative_feedback_rate BETWEEN 0 AND 1
      AND negative_feedback_rate <> 'NaN'::double precision
    );

COMMENT ON COLUMN public.creator_feed_stats.negative_feedback_count IS
  'Rendered deliveries answered with not-interested or hide-creator, plus two per non-dismissed report (one per post and reporter) on the creator''s posts, in the window.';
COMMENT ON COLUMN public.creator_feed_stats.negative_feedback_rate IS
  'Smoothed creator negative-feedback rate (negatives + 0.2) / (rendered + 20); v3 drops a creator from recommendations above the configured threshold.';

-- Reproduced from 20260808130000_feed_ranking_v2_starvation_free_refresh.sql
-- with one added count in `rollup`, the `report_rollup` and `scored` CTEs, and
-- the two negative-feedback columns in the upsert. Candidate selection, the
-- windows and every existing column are unchanged.
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
    LEFT JOIN public.creator_feed_stats AS existing
      ON existing.creator_user_id = facts.creator_user_id
    WHERE facts.creator_user_id IS NOT NULL
      AND facts.rendered_at IS NOT NULL
      AND facts.ranked_at >= p_as_of - interval '31 days'
      AND facts.ranked_at <= p_as_of
    GROUP BY facts.creator_user_id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, facts.creator_user_id
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
      count(facts.delivery_id) FILTER (
        WHERE facts.not_interested_at IS NOT NULL
          OR facts.hid_creator_at IS NOT NULL
      )::bigint AS negative_delivery_count,
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
  ),
  report_rollup AS (
    -- Aggregated apart from `rollup` so reports never multiply by deliveries.
    -- A report a moderator dismissed counts for nothing, and one account
    -- reporting the same post again adds nothing: the count is of distinct
    -- (post, reporter) pairs. A report whose reporter was deleted counts once.
    SELECT
      candidates.creator_user_id,
      windows.window_key,
      count(DISTINCT (
        reports.post_id::text || ':'
        || coalesce(reports.reporter_user_id::text, reports.id::text)
      ))::bigint AS report_count
    FROM candidate_creators AS candidates
    CROSS JOIN windows
    JOIN public.posts AS creator_posts
      ON creator_posts.user_id = candidates.creator_user_id
    JOIN public.post_reports AS reports
      ON reports.post_id = creator_posts.id
     AND reports.status <> 'dismissed'
     AND reports.created_at >= p_as_of - windows.duration
     AND reports.created_at <= p_as_of
    GROUP BY candidates.creator_user_id, windows.window_key
  ),
  scored AS (
    SELECT
      rollup.creator_user_id,
      rollup.window_key,
      rollup.rendered_count,
      rollup.meaningful_engagement_count,
      rollup.post_count,
      (
        rollup.negative_delivery_count
        + 2 * coalesce(report_rollup.report_count, 0)
      )::bigint AS negative_feedback_count
    FROM rollup
    LEFT JOIN report_rollup
      ON report_rollup.creator_user_id = rollup.creator_user_id
     AND report_rollup.window_key = rollup.window_key
  )
  INSERT INTO public.creator_feed_stats (
    creator_user_id,
    window_key,
    rendered_count,
    meaningful_engagement_count,
    post_count,
    quality_rate,
    negative_feedback_count,
    negative_feedback_rate,
    updated_at
  )
  SELECT
    scored.creator_user_id,
    scored.window_key,
    scored.rendered_count,
    scored.meaningful_engagement_count,
    scored.post_count,
    -- Bayesian toward a modest global rate so a creator with two lucky
    -- deliveries cannot outrank a proven one.
    least(
      1.0::double precision,
      (scored.meaningful_engagement_count::double precision + 3.0)
        / (scored.rendered_count::double precision + 20.0)
    ),
    scored.negative_feedback_count,
    -- The same 0.2 / 20 prior as a post's negative_feedback_risk, so a
    -- creator with no deliveries sits at 0.01, not at zero or at a guess.
    least(
      1.0::double precision,
      (scored.negative_feedback_count::double precision + 0.2)
        / (scored.rendered_count::double precision + 20.0)
    ),
    p_as_of
  FROM scored
  ON CONFLICT (creator_user_id, window_key) DO UPDATE
  SET rendered_count = EXCLUDED.rendered_count,
      meaningful_engagement_count = EXCLUDED.meaningful_engagement_count,
      post_count = EXCLUDED.post_count,
      quality_rate = EXCLUDED.quality_rate,
      negative_feedback_count = EXCLUDED.negative_feedback_count,
      negative_feedback_rate = EXCLUDED.negative_feedback_rate,
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
  'Refreshes bounded creator quality and negative-feedback aggregates from durable delivery facts and post reports.';

-- v1's event rollup, reproduced verbatim from
-- 20260711064036_feed_personalization_system.sql except that both
-- `session_item_id IS NOT NULL` predicates now read
-- `delivery_fact_id IS NOT NULL`. Session pruning nulls session_item_id about
-- two days after a session expires, so the old predicate shrank the 7d and 30d
-- windows to roughly two days; delivery_fact_id is stamped once by the event
-- validation trigger and never cleared. feed_events_post_occurred_idx
-- (post_id, occurred_at) still serves both lookups.
CREATE OR REPLACE FUNCTION public.refresh_post_feed_stats(
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
    RAISE EXCEPTION 'Feed stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Feed stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_post_feed_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_posts AS MATERIALIZED (
    SELECT p.id AS post_id
    FROM public.posts AS p
    LEFT JOIN public.post_feed_stats AS existing
      ON existing.post_id = p.id
    WHERE existing.post_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM public.feed_events AS recent_event
        WHERE recent_event.post_id = p.id
          AND recent_event.delivery_fact_id IS NOT NULL
          AND recent_event.occurred_at >= p_as_of - interval '31 days'
          AND recent_event.occurred_at <= p_as_of
      )
    GROUP BY p.id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, p.id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  raw_rollup AS (
    SELECT
      candidates.post_id,
      windows.window_key,
      count(events.id) FILTER (WHERE events.event_type = 'impression')::bigint
        AS impression_count,
      count(DISTINCT coalesce(events.viewer_user_id::text, 'anon:' || events.anonymous_key_hash))
        FILTER (WHERE events.event_type = 'impression')::bigint AS unique_viewer_count,
      count(events.id) FILTER (WHERE events.event_type = 'open')::bigint AS open_count,
      coalesce(
        sum(least(
          coalesce(events.duration_ms::double precision, events.event_value),
          3600000.0::double precision
        ))
          FILTER (WHERE events.event_type = 'dwell'),
        0.0::double precision
      )::bigint AS dwell_ms,
      count(events.id) FILTER (WHERE events.event_type = 'media_progress')::bigint
        AS media_progress_count,
      count(events.id) FILTER (WHERE events.event_type = 'quick_skip')::bigint
        AS quick_skip_count,
      count(events.id) FILTER (WHERE events.event_type = 'save')::bigint AS save_count,
      count(events.id) FILTER (WHERE events.event_type = 'share')::bigint AS share_count,
      count(events.id) FILTER (WHERE events.event_type = 'follow')::bigint AS follow_count,
      count(events.id) FILTER (WHERE events.event_type = 'remix_start')::bigint
        AS remix_start_count,
      count(events.id) FILTER (WHERE events.event_type = 'remix_complete')::bigint
        AS remix_complete_count,
      count(events.id) FILTER (WHERE events.event_type = 'resource_open')::bigint
        AS resource_open_count,
      count(events.id) FILTER (WHERE events.event_type = 'purchase')::bigint AS purchase_count,
      count(events.id) FILTER (WHERE events.event_type = 'not_interested')::bigint
        AS not_interested_count,
      count(events.id) FILTER (WHERE events.event_type = 'hide_creator')::bigint
        AS hide_creator_count,
      count(events.id) FILTER (WHERE events.event_type = 'report')::bigint AS report_count,
      max(events.occurred_at) AS last_event_at,
      max(events.received_at) AS last_event_received_at
    FROM candidate_posts AS candidates
    CROSS JOIN windows
    LEFT JOIN public.feed_events AS events
      ON events.post_id = candidates.post_id
     AND events.delivery_fact_id IS NOT NULL
     AND events.occurred_at >= p_as_of - windows.duration
     AND events.occurred_at <= p_as_of
    GROUP BY candidates.post_id, windows.window_key
  ),
  scored AS (
    SELECT
      raw.*,
      least(
        1.0::double precision,
        (
          2.0::double precision
          + 0.15::double precision * raw.open_count::double precision
          + 1.00::double precision * raw.save_count::double precision
          + 0.50::double precision * raw.share_count::double precision
          + 1.25::double precision * raw.follow_count::double precision
          + 1.50::double precision * raw.remix_start_count::double precision
          + 2.00::double precision * raw.remix_complete_count::double precision
          + 0.75::double precision * raw.resource_open_count::double precision
          + 2.50::double precision * raw.purchase_count::double precision
        ) / (raw.impression_count::double precision + 25.0::double precision)
      ) AS usefulness_score,
      least(
        1.0::double precision,
        (raw.quick_skip_count::double precision + 1.25::double precision)
          / (raw.impression_count::double precision + 5.0::double precision)
      ) AS quick_skip_rate,
      least(
        1.0::double precision,
        (
          raw.not_interested_count::double precision
          + raw.hide_creator_count::double precision
          + 2.0::double precision * raw.report_count::double precision
          + 0.2::double precision
        ) / (raw.impression_count::double precision + 20.0::double precision)
      ) AS negative_feedback_rate
    FROM raw_rollup AS raw
  )
  INSERT INTO public.post_feed_stats (
    post_id,
    window_key,
    impression_count,
    unique_viewer_count,
    open_count,
    dwell_ms,
    media_progress_count,
    quick_skip_count,
    save_count,
    share_count,
    follow_count,
    remix_start_count,
    remix_complete_count,
    resource_open_count,
    purchase_count,
    not_interested_count,
    hide_creator_count,
    report_count,
    usefulness_score,
    quick_skip_rate,
    negative_feedback_rate,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    scored.post_id,
    scored.window_key,
    scored.impression_count,
    scored.unique_viewer_count,
    scored.open_count,
    scored.dwell_ms,
    scored.media_progress_count,
    scored.quick_skip_count,
    scored.save_count,
    scored.share_count,
    scored.follow_count,
    scored.remix_start_count,
    scored.remix_complete_count,
    scored.resource_open_count,
    scored.purchase_count,
    scored.not_interested_count,
    scored.hide_creator_count,
    scored.report_count,
    scored.usefulness_score,
    scored.quick_skip_rate,
    scored.negative_feedback_rate,
    scored.last_event_at,
    scored.last_event_received_at,
    p_as_of
  FROM scored
  ON CONFLICT (post_id, window_key) DO UPDATE
  SET impression_count = EXCLUDED.impression_count,
      unique_viewer_count = EXCLUDED.unique_viewer_count,
      open_count = EXCLUDED.open_count,
      dwell_ms = EXCLUDED.dwell_ms,
      media_progress_count = EXCLUDED.media_progress_count,
      quick_skip_count = EXCLUDED.quick_skip_count,
      save_count = EXCLUDED.save_count,
      share_count = EXCLUDED.share_count,
      follow_count = EXCLUDED.follow_count,
      remix_start_count = EXCLUDED.remix_start_count,
      remix_complete_count = EXCLUDED.remix_complete_count,
      resource_open_count = EXCLUDED.resource_open_count,
      purchase_count = EXCLUDED.purchase_count,
      not_interested_count = EXCLUDED.not_interested_count,
      hide_creator_count = EXCLUDED.hide_creator_count,
      report_count = EXCLUDED.report_count,
      usefulness_score = EXCLUDED.usefulness_score,
      quick_skip_rate = EXCLUDED.quick_skip_rate,
      negative_feedback_rate = EXCLUDED.negative_feedback_rate,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer) IS
  'Idempotently refreshes Bayesian-smoothed feed stats for a bounded rotating post batch, counting events by their immutable delivery fact.';

-- The served-recently lookup in get_ranked_feed_candidates_v3 is a viewer (or
-- anonymous hash) prefixed range on served_at. feed_delivery_facts_viewer_ranked_idx
-- orders the viewer's facts by ranked_at, not served_at, and no index leads
-- with anonymous_key_hash at all, so a signed-out request would scan every
-- fact. One partial index per identity path keeps both lookups bounded by the
-- viewer's own recent deliveries.
CREATE INDEX IF NOT EXISTS feed_delivery_facts_viewer_served_idx
  ON public.feed_delivery_facts (viewer_user_id, served_at DESC)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_delivery_facts_anonymous_served_idx
  ON public.feed_delivery_facts (anonymous_key_hash, served_at DESC)
  WHERE anonymous_key_hash IS NOT NULL;

-- Candidate retrieval v3. A copy of get_ranked_feed_candidates_v2
-- (20260728181000) with these changes:
--   * eligible is bounded by p_max_age_days (cost, not freshness: v2's
--     catalog-wide CTE was a recorded promotion gate) and excludes NSFW posts,
--     the viewer's own posts, creators blocked in either direction and posts
--     the viewer reported -- in SQL, so they can no longer take session slots.
--   * served: the viewer's delivery facts in the last p_served_lookback_hours.
--     Served is not seen: a fact says the post was put on a page, not that it
--     was looked at. A served-but-unseen post is flagged for the caller's
--     served penalty; a seen one keeps v2's hard tier.
--   * cold pool (priority 2): new posts by authors the feed has barely
--     rendered in 30 days, newest first.
--   * trending ranks by projected 24h velocity, at most
--     p_trending_per_author_cap posts per author.
--   * deduplication keeps every source a post came from.
--   * negative_feedback_risk counts post_reports and divides by rendered
--     deliveries; creator_quality falls back to the prior mean instead of 0.
-- Like v2 there is no global ordering and no truncation beyond each pool's
-- own limit: TypeScript is the only scorer, and no weight lives in this SQL.
CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates_v3(
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
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_cold_limit integer DEFAULT 50,
  p_cold_max_age_hours integer DEFAULT 168,
  p_cold_impression_threshold integer DEFAULT 60,
  p_max_age_days integer DEFAULT 365,
  p_served_lookback_hours integer DEFAULT 6,
  p_trending_per_author_cap integer DEFAULT 5,
  p_creator_prior_mean double precision DEFAULT 0.15
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
  candidate_source text,
  served_recently boolean,
  is_following boolean,
  author_rendered_30d bigint,
  post_rendered_30d bigint,
  post_meaningful_30d bigint,
  post_age_hours double precision,
  reports_7d bigint,
  sources text[]
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
    OR p_cold_limit IS NULL OR p_cold_limit < 0 OR p_cold_limit > 500
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

  IF p_cold_max_age_hours IS NULL OR p_cold_max_age_hours < 0 OR p_cold_max_age_hours > 8760
    OR p_served_lookback_hours IS NULL OR p_served_lookback_hours < 0 OR p_served_lookback_hours > 8760
  THEN
    RAISE EXCEPTION 'Feed candidate hour windows must be between 0 and 8760';
  END IF;

  IF p_cold_impression_threshold IS NULL
    OR p_cold_impression_threshold < 0
    OR p_cold_impression_threshold > 100000
  THEN
    RAISE EXCEPTION 'Cold-start impression threshold must be between 0 and 100000';
  END IF;

  IF p_max_age_days IS NULL OR p_max_age_days < 1 OR p_max_age_days > 3650 THEN
    RAISE EXCEPTION 'Feed candidate max age days must be between 1 and 3650';
  END IF;

  IF p_trending_per_author_cap IS NULL
    OR p_trending_per_author_cap < 1
    OR p_trending_per_author_cap > 50
  THEN
    RAISE EXCEPTION 'Trending per-author cap must be between 1 and 50';
  END IF;

  IF p_creator_prior_mean IS NULL OR p_creator_prior_mean < 0 OR p_creator_prior_mean > 1 THEN
    RAISE EXCEPTION 'Creator prior mean must be between 0 and 1';
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
  served AS MATERIALIZED (
    -- Same shape as seen, over delivery facts (feed_delivery_facts_viewer_served_idx
    -- and feed_delivery_facts_anonymous_served_idx). p_served_lookback_hours = 0
    -- is the kill switch.
    SELECT facts.post_id, max(facts.served_at) AS last_served_at
    FROM public.feed_delivery_facts AS facts
    WHERE p_served_lookback_hours > 0
      AND facts.served_at >= p_as_of - make_interval(hours => p_served_lookback_hours)
      AND (
        (p_viewer_user_id IS NOT NULL AND facts.viewer_user_id = p_viewer_user_id)
        OR (
          p_viewer_user_id IS NULL
          AND p_anonymous_key_hash IS NOT NULL
          AND facts.anonymous_key_hash = p_anonymous_key_hash
        )
      )
    GROUP BY facts.post_id
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
      seen.last_seen_at,
      (served.post_id IS NOT NULL) AS served_recently
    FROM public.posts AS p
    LEFT JOIN seen ON seen.post_id = p.id
    LEFT JOIN served ON served.post_id = p.id
    WHERE p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
      AND p.is_nsfw = false
      AND p.created_at >= p_as_of - make_interval(days => p_max_age_days)
      AND p.user_id IS DISTINCT FROM p_viewer_user_id
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
      -- A block hides content in both directions. Two anti-joins rather than
      -- one OR so each direction is a primary-key or
      -- user_blocks_blocked_user_idx probe.
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p_viewer_user_id
            AND blocks.blocked_user_id = p.user_id
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p.user_id
            AND blocks.blocked_user_id = p_viewer_user_id
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.post_reports AS reports
          WHERE reports.reporter_user_id = p_viewer_user_id
            AND reports.post_id = p.id
        )
      )
  ),
  posterior AS (
    -- Beta(successes + 1, failures + 1) over rendered deliveries, 30d. The raw
    -- counts are returned too: the caller's cold-start slot draws from its own
    -- Beta prior over them.
    SELECT
      e.id AS post_id,
      coalesce(stats.rendered_count, 0)::bigint AS rendered_30d,
      coalesce(stats.meaningful_engagement_count, 0)::bigint AS meaningful_30d,
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
      posterior.rendered_30d,
      posterior.meaningful_30d,
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
  trend_scores AS (
    -- X ranks popular posts by projected 24-hour reach. Renders so far are
    -- projected to a full day assuming exposure decays with an 8-hour
    -- half-life (lambda = ln 2 / 8):
    --   projected = rendered_24h * (1 - exp(-24 lambda)) / (1 - exp(-lambda * max(age_h, 0.5)))
    -- so a two-hour-old post with 10 renders outranks a day-old post with 12.
    -- The projection only scales the volume factor; the meaningful-engagement
    -- rate still decides quality. Used by the trending pool and, as the
    -- relevant_trend feature, by the caller.
    SELECT
      e.id AS post_id,
      e.creator_id,
      e.seen_recently,
      e.created_at,
      stats.rendered_count AS rendered_24h,
      least(
        1.0::double precision,
        greatest(
          0.0::double precision,
          coalesce(stats.meaningful_engagement_rate, 0.0::double precision)
            * least(
              1.0::double precision,
              ln(1.0::double precision + projection.projected_24h)
                / ln(101.0::double precision)
            )
        )
      ) AS velocity
    FROM eligible AS e
    JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id
     AND stats.window_key = '24h'
    CROSS JOIN LATERAL (
      SELECT
        greatest(0, stats.rendered_count)::double precision
          * (
            1.0::double precision
            - exp(-(ln(2.0::double precision) / 8.0::double precision) * 24.0::double precision)
          )
          / (
            1.0::double precision
            - exp(
              -(ln(2.0::double precision) / 8.0::double precision)
              * greatest(
                extract(epoch FROM (p_as_of - e.created_at))::double precision
                  / 3600.0::double precision,
                0.5::double precision
              )
            )
          ) AS projected_24h
    ) AS projection
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
  cold_pool AS (
    -- X's cold source: new posts from authors the feed has barely shown. An
    -- author with no 30d creator_feed_stats row has never been rendered, so
    -- that counts as zero exposure.
    SELECT e.id AS post_id, 'cold'::text AS source, 2 AS source_priority
    FROM eligible AS e
    LEFT JOIN public.creator_feed_stats AS creator_stats
      ON creator_stats.creator_user_id = e.creator_id
     AND creator_stats.window_key = '30d'
    WHERE e.created_at >= p_as_of - make_interval(hours => p_cold_max_age_hours)
      AND coalesce(creator_stats.rendered_count, 0) < p_cold_impression_threshold
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_cold_limit
  ),
  interest_pool AS (
    SELECT e.id AS post_id, 'affinity'::text AS source, 3 AS source_priority
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
    SELECT e.post_id, 'trending'::text AS source, 4 AS source_priority
    FROM (
      SELECT
        trend.*,
        row_number() OVER (
          PARTITION BY trend.creator_id
          ORDER BY trend.velocity DESC, trend.created_at DESC, trend.post_id DESC
        ) AS author_rank
      FROM trend_scores AS trend
    ) AS e
    WHERE e.author_rank <= p_trending_per_author_cap
    ORDER BY e.seen_recently ASC,
      e.velocity DESC,
      e.rendered_24h DESC,
      e.created_at DESC,
      e.post_id DESC
    LIMIT p_trending_limit
  ),
  recent_pool AS (
    SELECT e.id AS post_id, 'fresh'::text AS source, 5 AS source_priority
    FROM eligible AS e
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_recent_limit
  ),
  exploration_pool AS (
    SELECT e.id AS post_id, 'exploration'::text AS source, 6 AS source_priority
    FROM eligible AS e
    JOIN exploration_scores AS scores ON scores.post_id = e.id
    ORDER BY e.seen_recently ASC, scores.exploration_ucb DESC, e.created_at DESC, e.id DESC
    LIMIT p_exploration_limit
  ),
  pooled AS (
    SELECT * FROM following_pool
    UNION ALL SELECT * FROM cold_pool
    UNION ALL SELECT * FROM interest_pool
    UNION ALL SELECT * FROM trending_pool
    UNION ALL SELECT * FROM recent_pool
    UNION ALL SELECT * FROM exploration_pool
  ),
  deduplicated AS (
    -- Every source a post came from, in pool-priority order; the first one is
    -- candidate_source, the label v2's DISTINCT ON kept. Postgres refuses
    -- DISTINCT together with an ORDER BY on another expression inside one
    -- aggregate, so duplicates are removed in the subquery instead.
    SELECT
      pool.post_id,
      (array_agg(pool.source ORDER BY pool.source_priority))[1] AS source,
      array_agg(pool.source ORDER BY pool.source_priority) AS sources
    FROM (
      SELECT DISTINCT pooled.post_id, pooled.source, pooled.source_priority
      FROM pooled
    ) AS pool
    GROUP BY pool.post_id
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
      greatest(0.0::double precision, coalesce(trend.velocity, 0.0::double precision))
    ) AS relevant_trend,
    1.0::double precision
      / sqrt(1.0::double precision + coalesce(stats_30d.impression_count, 0)::double precision / 20.0::double precision)
      AS exploration_bonus,
    least(
      1.0::double precision,
      (coalesce(stats_7d.quick_skip_delivery_count, 0)::double precision + 1.0::double precision)
        / (coalesce(stats_7d.rendered_count, 0)::double precision + 8.0::double precision)
    ) AS quick_skip_risk,
    -- Reports come from post_reports (the report feed event was never
    -- emitted), and the denominator is rendered deliveries, as every other
    -- fact-derived rate.
    least(
      1.0::double precision,
      (
        coalesce(stats_7d.not_interested_count, 0)::double precision
        + coalesce(stats_7d.hide_creator_count, 0)::double precision
        + (2.0::double precision * coalesce(post_reports_7d.report_count, 0)::double precision)
        + 0.2::double precision
      ) / (coalesce(stats_7d.rendered_count, 0)::double precision + 20.0::double precision)
    ) AS negative_feedback_risk,
    coalesce(stats_7d.engagement_depth, 0.25::double precision) AS engagement_depth,
    coalesce(stats_7d.attention_seconds_norm, 0.0::double precision) AS attention_seconds_norm,
    -- A creator with no stats row has simply not been measured yet: give it
    -- the prior mean, not zero, so new authors are not penalised.
    least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, p_creator_prior_mean))
      AS creator_quality,
    coalesce(scores.exploration_ucb, 0.0::double precision) AS exploration_ucb,
    e.seen_recently,
    e.last_seen_at,
    d.source,
    e.served_recently,
    follow_state.is_following,
    coalesce(creator_stats.rendered_count, 0)::bigint AS author_rendered_30d,
    coalesce(scores.rendered_30d, 0)::bigint AS post_rendered_30d,
    coalesce(scores.meaningful_30d, 0)::bigint AS post_meaningful_30d,
    greatest(
      0.0::double precision,
      extract(epoch FROM (p_as_of - e.created_at))::double precision / 3600.0::double precision
    ) AS post_age_hours,
    coalesce(post_reports_7d.report_count, 0)::bigint AS reports_7d,
    d.sources
  FROM deduplicated AS d
  JOIN eligible AS e ON e.id = d.post_id
  LEFT JOIN exploration_scores AS scores ON scores.post_id = e.id
  LEFT JOIN trend_scores AS trend ON trend.post_id = e.id
  LEFT JOIN public.post_feed_stats AS stats_7d
    ON stats_7d.post_id = e.id AND stats_7d.window_key = '7d'
  LEFT JOIN public.post_feed_stats AS stats_30d
    ON stats_30d.post_id = e.id AND stats_30d.window_key = '30d'
  LEFT JOIN public.creator_feed_stats AS creator_stats
    ON creator_stats.creator_user_id = e.creator_id AND creator_stats.window_key = '30d'
  LEFT JOIN LATERAL (
    -- Non-dismissed reports in the 7-day window, one per reporter, so a
    -- single account cannot multiply its own report.
    SELECT count(DISTINCT coalesce(reports.reporter_user_id::text, reports.id::text))::bigint
      AS report_count
    FROM public.post_reports AS reports
    WHERE reports.post_id = e.id
      AND reports.status <> 'dismissed'
      AND reports.created_at >= p_as_of - interval '7 days'
      AND reports.created_at <= p_as_of
  ) AS post_reports_7d ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.follows AS f
      WHERE f.follower_id = p_viewer_user_id
        AND f.following_id = e.creator_id
    ) AS is_following
  ) AS follow_state ON true
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
        CASE WHEN follow_state.is_following THEN 0.75::double precision ELSE 0.0::double precision END
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

REVOKE ALL ON FUNCTION public.get_ranked_feed_candidates_v3(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ranked_feed_candidates_v3(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision
) TO service_role;

COMMENT ON FUNCTION public.get_ranked_feed_candidates_v3(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision
) IS
  'Returns the unranked, age-bounded per-pool candidate union (following, cold, affinity, velocity trending, fresh, exploration) with every source, seen and served flags, safety exclusions applied, and the raw counts the caller''s cold-start slot needs; scoring belongs to the caller.';

-- Activate a draft, shadow or retired version: retire the key's current active
-- version, then activate the target, in one transaction. A retired target is a
-- rollback ("activate the previous version"), so its retired_at is cleared in
-- the same UPDATE: feed_algorithm_versions_lifecycle_check would otherwise see
-- a retirement older than the new activation. An already active target is
-- refused. This is two UPDATEs on purpose:
-- feed_algorithm_versions_one_active_idx is a partial unique index, which
-- Postgres checks row by row and cannot defer, so a single UPDATE that
-- touches both rows succeeds or fails depending on the order it happens to
-- visit them. An advisory lock per algorithm key serialises concurrent
-- activations; the second one then sees the first one's result and either
-- retires it or refuses.
CREATE OR REPLACE FUNCTION public.activate_feed_algorithm_version(p_version_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_target public.feed_algorithm_versions%ROWTYPE;
  v_previous_active_id uuid;
BEGIN
  IF p_version_id IS NULL THEN
    RAISE EXCEPTION 'Feed algorithm version id is required';
  END IF;

  SELECT versions.* INTO v_target
  FROM public.feed_algorithm_versions AS versions
  WHERE versions.id = p_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Feed algorithm version does not exist';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('activate_feed_algorithm_version:' || v_target.algorithm_key, 0)
  );

  -- Read again under the lock: a concurrent activation may have changed it.
  SELECT versions.* INTO v_target
  FROM public.feed_algorithm_versions AS versions
  WHERE versions.id = p_version_id
  FOR UPDATE;

  IF v_target.status NOT IN ('draft', 'shadow', 'retired') THEN
    RAISE EXCEPTION 'Feed algorithm version is already active';
  END IF;

  UPDATE public.feed_algorithm_versions AS versions
  SET status = 'retired',
      retired_at = v_now
  WHERE versions.algorithm_key = v_target.algorithm_key
    AND versions.status = 'active'
  RETURNING versions.id INTO v_previous_active_id;

  -- retired_at is NULL already for a draft or shadow target; for a retired
  -- one (a rollback) clearing it is what lets the row be active again.
  UPDATE public.feed_algorithm_versions AS versions
  SET status = 'active',
      activated_at = v_now,
      retired_at = NULL
  WHERE versions.id = v_target.id;

  RETURN jsonb_build_object(
    'previous_active_id', v_previous_active_id,
    'activated_id', v_target.id,
    'algorithm_key', v_target.algorithm_key,
    'version', v_target.version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_feed_algorithm_version(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_feed_algorithm_version(uuid)
  TO service_role;

COMMENT ON FUNCTION public.activate_feed_algorithm_version(uuid) IS
  'Atomically retires the active version of the target''s algorithm key and activates the draft, shadow or retired (rollback) target; refuses an active target. Service role only.';

-- Create an experiment and its variants in one call. Everything is validated
-- before the first insert; an error anywhere leaves nothing behind.
CREATE OR REPLACE FUNCTION public.create_feed_experiment(
  p_experiment jsonb,
  p_variants jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_experiment_key text;
  v_status text;
  v_traffic numeric;
  v_assignment_salt text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_variant jsonb;
  v_variant_key text;
  v_variant_keys text[] := ARRAY[]::text[];
  v_version_id_text text;
  v_version_status text;
  v_allocation numeric;
  v_allocation_total numeric := 0;
  v_experiment_id uuid;
  v_variants jsonb;
BEGIN
  IF p_experiment IS NULL OR jsonb_typeof(p_experiment) <> 'object' THEN
    RAISE EXCEPTION 'Feed experiment must be a JSON object';
  END IF;

  v_experiment_key := btrim(p_experiment->>'experiment_key');
  IF v_experiment_key IS NULL OR char_length(v_experiment_key) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Feed experiment key must be 1 to 100 characters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.feed_experiments AS experiments
    WHERE experiments.experiment_key = v_experiment_key
  ) THEN
    RAISE EXCEPTION 'Feed experiment key already exists';
  END IF;

  v_status := coalesce(p_experiment->>'status', 'running');
  IF v_status NOT IN ('draft', 'running', 'paused', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Feed experiment status must be draft, running, paused, completed or cancelled';
  END IF;

  IF jsonb_typeof(p_experiment->'traffic_basis_points') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Feed experiment traffic_basis_points must be an integer between 1 and 10000';
  END IF;
  v_traffic := (p_experiment->>'traffic_basis_points')::numeric;
  IF v_traffic <> trunc(v_traffic) OR v_traffic < 1 OR v_traffic > 10000 THEN
    RAISE EXCEPTION 'Feed experiment traffic_basis_points must be an integer between 1 and 10000';
  END IF;

  v_assignment_salt := coalesce(
    nullif(btrim(p_experiment->>'assignment_salt'), ''),
    gen_random_uuid()::text
  );
  v_starts_at := coalesce((p_experiment->>'starts_at')::timestamptz, v_now);
  v_ends_at := (p_experiment->>'ends_at')::timestamptz;
  IF v_ends_at IS NOT NULL AND v_ends_at <= v_starts_at THEN
    RAISE EXCEPTION 'Feed experiment ends_at must be after starts_at';
  END IF;

  IF p_variants IS NULL
    OR jsonb_typeof(p_variants) <> 'array'
    OR jsonb_array_length(p_variants) = 0
  THEN
    RAISE EXCEPTION 'Feed experiment variants must be a non-empty JSON array';
  END IF;

  FOR v_variant IN
    SELECT variant.value FROM jsonb_array_elements(p_variants) AS variant(value)
  LOOP
    IF jsonb_typeof(v_variant) <> 'object' THEN
      RAISE EXCEPTION 'Each feed experiment variant must be a JSON object';
    END IF;

    v_variant_key := btrim(v_variant->>'variant_key');
    IF v_variant_key IS NULL OR char_length(v_variant_key) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION 'Feed experiment variant keys must be 1 to 80 characters';
    END IF;
    IF v_variant_key = ANY (v_variant_keys) THEN
      RAISE EXCEPTION 'Feed experiment variant keys must be unique';
    END IF;
    v_variant_keys := array_append(v_variant_keys, v_variant_key);

    IF jsonb_typeof(v_variant->'allocation_basis_points') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Feed experiment variant allocation_basis_points must be an integer between 0 and 10000';
    END IF;
    v_allocation := (v_variant->>'allocation_basis_points')::numeric;
    IF v_allocation <> trunc(v_allocation) OR v_allocation < 0 OR v_allocation > 10000 THEN
      RAISE EXCEPTION 'Feed experiment variant allocation_basis_points must be an integer between 0 and 10000';
    END IF;
    v_allocation_total := v_allocation_total + v_allocation;

    v_version_id_text := v_variant->>'algorithm_version_id';
    IF v_version_id_text IS NULL
      OR v_version_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Feed experiment variant algorithm_version_id must be a uuid';
    END IF;

    SELECT versions.status INTO v_version_status
    FROM public.feed_algorithm_versions AS versions
    WHERE versions.id = v_version_id_text::uuid;

    IF v_version_status IS NULL OR v_version_status NOT IN ('active', 'shadow') THEN
      RAISE EXCEPTION 'Feed experiment variants must reference an active or shadow algorithm version';
    END IF;
  END LOOP;

  IF v_allocation_total <> 10000 THEN
    RAISE EXCEPTION 'Feed experiment variant allocations must sum to exactly 10000 basis points';
  END IF;

  INSERT INTO public.feed_experiments (
    experiment_key,
    status,
    traffic_basis_points,
    assignment_salt,
    starts_at,
    ends_at
  )
  VALUES (
    v_experiment_key,
    v_status,
    v_traffic::integer,
    v_assignment_salt,
    v_starts_at,
    v_ends_at
  )
  RETURNING feed_experiments.id INTO v_experiment_id;

  WITH inserted AS (
    INSERT INTO public.feed_experiment_variants (
      experiment_id,
      variant_key,
      algorithm_version_id,
      allocation_basis_points
    )
    SELECT
      v_experiment_id,
      btrim(variant.value->>'variant_key'),
      (variant.value->>'algorithm_version_id')::uuid,
      (variant.value->>'allocation_basis_points')::numeric::integer
    FROM jsonb_array_elements(p_variants) AS variant(value)
    RETURNING
      feed_experiment_variants.id,
      feed_experiment_variants.variant_key,
      feed_experiment_variants.algorithm_version_id,
      feed_experiment_variants.allocation_basis_points
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', inserted.id,
      'variant_key', inserted.variant_key,
      'algorithm_version_id', inserted.algorithm_version_id,
      'allocation_basis_points', inserted.allocation_basis_points
    )
    ORDER BY inserted.variant_key
  )
  INTO v_variants
  FROM inserted;

  RETURN jsonb_build_object(
    'experiment_id', v_experiment_id,
    'experiment_key', v_experiment_key,
    'status', v_status,
    'traffic_basis_points', v_traffic::integer,
    'starts_at', v_starts_at,
    'ends_at', v_ends_at,
    'variants', v_variants
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_feed_experiment(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_feed_experiment(jsonb, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.create_feed_experiment(jsonb, jsonb) IS
  'Creates a feed experiment and its variants atomically; variants must reference active or shadow versions and allocate exactly 10000 basis points. Service role only.';

CREATE OR REPLACE FUNCTION public.set_feed_experiment_status(
  p_experiment_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_experiment public.feed_experiments%ROWTYPE;
BEGIN
  IF p_experiment_id IS NULL THEN
    RAISE EXCEPTION 'Feed experiment id is required';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('paused', 'completed', 'cancelled', 'running') THEN
    RAISE EXCEPTION 'Feed experiment status must be paused, completed, cancelled or running';
  END IF;

  SELECT experiments.* INTO v_experiment
  FROM public.feed_experiments AS experiments
  WHERE experiments.id = p_experiment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Feed experiment does not exist';
  END IF;

  UPDATE public.feed_experiments AS experiments
  SET status = p_status
  WHERE experiments.id = p_experiment_id;

  RETURN jsonb_build_object(
    'experiment_id', v_experiment.id,
    'experiment_key', v_experiment.experiment_key,
    'previous_status', v_experiment.status,
    'status', p_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_feed_experiment_status(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_feed_experiment_status(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.set_feed_experiment_status(uuid, text) IS
  'Moves a feed experiment to paused, completed, cancelled or running; service role only.';

-- Outcome counts per algorithm version, experiment variant and candidate
-- source over the facts served in the last p_days, plus one all-sources row
-- (candidate_source NULL) per version and variant. Raw counts only: the ops
-- CLI derives the rates so numerators and denominators stay visible.
--   meaningful        is_meaningful_feed_engagement over rendered deliveries
--   negatives         not interested, hide creator or report
--   repeat_exposures  the viewer already had a qualified impression of the
--                     post in the 14 days before it was served again
CREATE OR REPLACE FUNCTION public.feed_algorithm_scorecard(p_days integer DEFAULT 7)
RETURNS TABLE (
  algorithm_version_id uuid,
  algorithm_label text,
  experiment_variant_id uuid,
  variant_key text,
  candidate_source text,
  served bigint,
  rendered bigint,
  qualified bigint,
  meaningful bigint,
  quick_skips bigint,
  negatives bigint,
  saves bigint,
  remix_starts bigint,
  distinct_viewers bigint,
  repeat_exposures bigint,
  avg_position double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'Feed scorecard days must be between 1 and 30';
  END IF;

  RETURN QUERY
  WITH windowed AS (
    SELECT
      facts.algorithm_version_id AS version_id,
      facts.experiment_variant_id AS variant_id,
      facts.candidate_source AS source,
      facts.position AS delivery_position,
      coalesce(facts.viewer_user_id::text, facts.anonymous_key_hash) AS viewer_key,
      (facts.rendered_at IS NOT NULL) AS was_rendered,
      (facts.qualified_impression_at IS NOT NULL) AS was_qualified,
      (
        facts.rendered_at IS NOT NULL
        AND public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at
        )
      ) AS was_meaningful,
      (facts.quick_skipped_at IS NOT NULL) AS was_quick_skipped,
      (
        facts.not_interested_at IS NOT NULL
        OR facts.hid_creator_at IS NOT NULL
        OR facts.reported_at IS NOT NULL
      ) AS was_negative,
      (facts.saved_at IS NOT NULL) AS was_saved,
      (facts.remix_started_at IS NOT NULL) AS was_remix_started,
      (
        (
          facts.viewer_user_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.feed_events AS events
            WHERE events.event_type = 'impression'
              AND events.viewer_user_id = facts.viewer_user_id
              AND events.post_id = facts.post_id
              AND events.occurred_at >= facts.served_at - interval '14 days'
              AND events.occurred_at < facts.served_at
          )
        )
        OR (
          facts.viewer_user_id IS NULL
          AND facts.anonymous_key_hash IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.feed_events AS events
            WHERE events.event_type = 'impression'
              AND events.anonymous_key_hash = facts.anonymous_key_hash
              AND events.post_id = facts.post_id
              AND events.occurred_at >= facts.served_at - interval '14 days'
              AND events.occurred_at < facts.served_at
          )
        )
      ) AS was_repeat_exposure
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    WHERE facts.served_at >= now() - make_interval(days => p_days)
  )
  SELECT
    windowed.version_id,
    versions.algorithm_key || '-v' || versions.version::text,
    windowed.variant_id,
    variants.variant_key,
    windowed.source,
    count(*)::bigint,
    count(*) FILTER (WHERE windowed.was_rendered)::bigint,
    count(*) FILTER (WHERE windowed.was_qualified)::bigint,
    count(*) FILTER (WHERE windowed.was_meaningful)::bigint,
    count(*) FILTER (WHERE windowed.was_quick_skipped)::bigint,
    count(*) FILTER (WHERE windowed.was_negative)::bigint,
    count(*) FILTER (WHERE windowed.was_saved)::bigint,
    count(*) FILTER (WHERE windowed.was_remix_started)::bigint,
    count(DISTINCT windowed.viewer_key)::bigint,
    count(*) FILTER (WHERE windowed.was_repeat_exposure)::bigint,
    avg(windowed.delivery_position)::double precision
  FROM windowed
  JOIN public.feed_algorithm_versions AS versions ON versions.id = windowed.version_id
  LEFT JOIN public.feed_experiment_variants AS variants ON variants.id = windowed.variant_id
  -- One row per (version, variant, source) and one all-sources row per
  -- (version, variant) with candidate_source NULL. Facts always carry a
  -- source, so a NULL source only ever means the all-sources row, and its
  -- distinct_viewers is the exact per-version count (per-source counts cannot
  -- be summed: a viewer reached through two sources would count twice).
  GROUP BY GROUPING SETS (
    (
      windowed.version_id,
      versions.algorithm_key,
      versions.version,
      windowed.variant_id,
      variants.variant_key,
      windowed.source
    ),
    (
      windowed.version_id,
      versions.algorithm_key,
      versions.version,
      windowed.variant_id,
      variants.variant_key
    )
  )
  ORDER BY 2, 4 NULLS FIRST, 5 NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_algorithm_scorecard(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_algorithm_scorecard(integer)
  TO service_role;

COMMENT ON FUNCTION public.feed_algorithm_scorecard(integer) IS
  'Per version, variant and candidate source outcome counts over feed delivery facts served in the last 1 to 30 days, plus an all-sources row (candidate_source NULL) per version and variant; service role only.';

-- for-you-rules v3, inserted as SHADOW: nothing serves it until it is either
-- activated or referenced by an experiment variant. The weights are starting
-- points for the scorecard to tune. negative_feedback_risk moves from -0.80 to
-- -2.5 so one report among 20 rendered deliveries sinks a post below an
-- unremarkable one: -2.5 * (2 + 0.2) / 40 = -0.14 against a typical +0.3 to
-- +0.6. Every key the TypeScript defaults do not know reproduces v1/v2 there,
-- so these values only take effect through this row.
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
  3,
  'shadow',
  'X-adoption: author-diversity decay, out-of-network discount, Thompson cold-start slot, cold pool, velocity trending, served-recently penalty, net-negative sink, visibility stage with recommendation-only rules, report-aware negatives.',
  jsonb_build_object(
    'interest_match', 0.24,
    'creator_affinity', 0.12,
    'smoothed_usefulness', 0.10,
    'engagement_depth', 0.22,
    'attention_seconds_norm', 0.08,
    'freshness', 0.12,
    'relevant_trend', 0.08,
    'creator_quality', 0.06,
    'exploration_ucb', 0.10,
    'exploration_bonus', 0.0,
    'quick_skip_risk', -0.30,
    'negative_feedback_risk', -2.5
  ),
  jsonb_build_object(
    'candidate_rpc', 'v3',
    'following_limit', 100,
    'interest_limit', 150,
    'trending_limit', 100,
    'recent_limit', 150,
    'exploration_limit', 100,
    'cold_limit', 50,
    'cold_max_age_hours', 168,
    'cold_impression_threshold', 60,
    'max_age_days', 365,
    'served_lookback_hours', 6,
    'trending_per_author_cap', 5,
    'seen_lookback_days', 14,
    'seen_penalty', 0.2,
    'creator_prior_cap', 0.15,
    'creator_prior_mean', 0.15,
    'exploration_confidence', 1.5,
    'session_item_limit', 60,
    'recommendation_max_post_negative_risk', 0.12,
    'recommendation_max_creator_negative_rate', 0.08
  ),
  jsonb_build_object(
    'max_creator_per_20', 3,
    'max_semantic_cluster_per_20', 3,
    'exploration_per_10', 1,
    'max_paid_share', 0.20,
    'author_decay', 0.5,
    'author_decay_floor', 0.25,
    'out_of_network_multiplier', 0.75,
    'served_penalty', 0.5,
    'cold_start_slot_rank', 6,
    'cold_start_max_age_hours', 168,
    'cold_start_impression_threshold', 60,
    'cold_start_prior_mean', 0.15,
    'cold_start_prior_strength', 50
  )
)
ON CONFLICT (algorithm_key, version) DO NOTHING;

-- Stop the v2 stats refreshes from starving every row past the first p_limit.
--
-- Both functions picked their candidates with `ORDER BY <uuid> LIMIT p_limit`,
-- which is a stable order over a set that does not shrink: once more than
-- p_limit rows qualify, every hourly run reprocesses the same lowest-uuid
-- 1,000 and the remainder never refreshes again. Their quality_rate freezes at
-- whatever it held when the table crossed the limit.
--
-- The fix is the idiom v1 already uses (`refresh_post_feed_stats` and
-- `refresh_user_interest_weights` in 20260711064036): left join the stats table
-- the function writes and take the least-recently-refreshed candidates first,
-- NULLS FIRST so rows that have never been computed lead. Refreshing a row sets
-- its updated_at, which sends it to the back of the queue -- so the cursor
-- advances on its own and every candidate is reached in bounded time.
--
-- v2 is still seeded 'shadow', so this is an activation blocker rather than a
-- repair of live damage. It must land before v2 is promoted.
--
-- Functions are reproduced verbatim from 20260728181000_feed_ranking_v2.sql
-- apart from the candidate CTEs, so a diff against that file shows only the
-- selection change.

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
    LEFT JOIN public.post_feed_stats AS existing
      ON existing.post_id = facts.post_id
    WHERE facts.ranked_at >= p_as_of - interval '31 days'
      AND facts.ranked_at <= p_as_of
    GROUP BY facts.post_id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, facts.post_id
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

-- refresh_creator_feed_stats filters and groups on exactly these two columns,
-- and this is the one unindexed-foreign-key finding from Supabase's performance
-- advisor. Without it the candidate scan above is a sequential read of the
-- largest table in the schema.
CREATE INDEX IF NOT EXISTS feed_delivery_facts_creator_ranked_idx
  ON public.feed_delivery_facts (creator_user_id, ranked_at);

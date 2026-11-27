-- refresh_post_feed_engagement_stats reads the 30-day facts once, refreshes only the posts whose
-- rows can change, and writes only the rows that change (database audit, 2026-11-27).
--
-- Production: 2,911 calls, 1,649 ms mean, 5,937 ms worst, the heaviest statement in the database.
-- Its candidate step joined the 31-day facts to post_feed_stats, which has three window rows per
-- post, so every fact was matched three times; its rollup then read each candidate's facts once
-- per window (CROSS JOIN windows, LEFT JOIN feed_delivery_facts).
--
-- Now: the candidate step reads its cursor from the 24h row only. The rollup reads the
-- candidates' facts of the 30-day window once (MATERIALIZED) and each window takes its part of
-- them in memory; the aggregates are unchanged, so every value is computed as before.
--
-- Candidates: a fact in the last 31 days, as before, or engagement counts still held. The second
-- is new: a post whose facts left every window was zeroed only if a refresh reached it in the day
-- between 30 and 31 days, and otherwise kept its counts for good. Rows whose counts are all zero
-- (never refreshed here, or already zeroed) are left as they are, as before.
--
-- Rotation and writes as in refresh_post_feed_stats (20261127060310), on a cursor of this
-- refresh's own, engagement_refreshed_at (added there): the 24h row is written on every refresh
-- and carries it; the 7d and 30d rows are written only when a value changed. The event refresh
-- runs just before this one at the same p_as_of and never writes this cursor, so it cannot keep
-- a post at the back of this rotation. The return value is the number of posts refreshed, as
-- before (it was rows / 3).
-- Name, arguments, return type, invoker rights, search_path and grants are unchanged; the body is
-- the live definition from a clean replay with the candidate step, the fact read and the write
-- guard changed. supabase/tests/database/post_feed_engagement_stats_refresh_incremental.test.sql
-- proves identical rows against the old function, the zeroing, the skipped writes and rotation.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.refresh_post_feed_engagement_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_post_ids uuid[];
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

  -- A candidate is a post with a fact in the last 31 days (its windows slide with no new fact), or
  -- one whose rows still hold engagement counts: once its facts have left every window it needs
  -- one refresh that zeroes them, which the old candidate step gave only to a post refreshed in the
  -- day between 30 and 31 days. A row whose counts are all zero is left as it is, as before.
  -- The cursor is read on the 24h row only: joining all three window rows matched each post three times.
  SELECT array_agg(candidate.post_id ORDER BY candidate.last_refreshed_at ASC NULLS FIRST, candidate.post_id)
  INTO v_post_ids
  FROM (
    SELECT changing.post_id, marker.engagement_refreshed_at AS last_refreshed_at
    FROM (
      SELECT facts.post_id
      FROM public.feed_delivery_facts AS facts
      WHERE facts.ranked_at >= p_as_of - interval '31 days'
        AND facts.ranked_at <= p_as_of

      UNION

      SELECT counted.post_id
      FROM public.post_feed_stats AS counted
      WHERE counted.served_delivery_count > 0
         OR counted.rendered_count > 0
         OR counted.video_start_count > 0
         OR counted.video_half_completion_count > 0
         OR counted.video_completion_count > 0
         OR counted.attention_ms_total > 0
         OR counted.attention_delivery_count > 0
         OR counted.meaningful_engagement_count > 0
         OR counted.quick_skip_delivery_count > 0
         OR counted.exploration_delivery_count > 0
         OR counted.exploration_success_count > 0
    ) AS changing
    -- This refresh's own cursor, on the 24h row it writes every time: the least recently refreshed
    -- come first, posts with no row (or never refreshed here) before all.
    LEFT JOIN public.post_feed_stats AS marker
      ON marker.post_id = changing.post_id
     AND marker.window_key = '24h'
    ORDER BY marker.engagement_refreshed_at ASC NULLS FIRST, changing.post_id
    LIMIT p_limit
  ) AS candidate;

  IF coalesce(cardinality(v_post_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  -- The candidates' facts of the widest window, read once; each window below takes its part of
  -- them in memory instead of reading the table again.
  WITH window_facts AS MATERIALIZED (
    SELECT
      facts.post_id,
      facts.delivery_id,
      facts.ranked_at,
      facts.served_at,
      facts.rendered_at,
      facts.media_progress_max,
      facts.media_duration_ms,
      facts.dwell_ms_max,
      facts.saved_at,
      facts.remix_started_at,
      facts.resource_opened_at,
      facts.purchased_at,
      facts.commented_at,
      facts.quick_skipped_at,
      facts.is_exploration
    FROM public.feed_delivery_facts AS facts
    WHERE facts.post_id = ANY(v_post_ids)
      AND facts.ranked_at >= p_as_of - interval '30 days'
      AND facts.ranked_at <= p_as_of
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
            facts.purchased_at,
            facts.commented_at
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
            facts.purchased_at,
            facts.commented_at
          )
      )::bigint AS exploration_success_count
    FROM unnest(v_post_ids) AS candidates(post_id)
    CROSS JOIN windows
    JOIN public.posts AS posts ON posts.id = candidates.post_id
    LEFT JOIN window_facts AS facts
      ON facts.post_id = candidates.post_id
     AND facts.ranked_at >= p_as_of - windows.duration
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
    updated_at,
    engagement_refreshed_at
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
    p_as_of,
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
      updated_at = EXCLUDED.updated_at,
      engagement_refreshed_at = EXCLUDED.engagement_refreshed_at
  -- The 24h row always (it carries the cursor); the others only when a value changed.
  WHERE stats.window_key = '24h'
     OR (
        stats.served_delivery_count, stats.rendered_count, stats.video_start_count,
        stats.video_half_completion_count, stats.video_completion_count, stats.attention_ms_total,
        stats.attention_delivery_count, stats.meaningful_engagement_count,
        stats.quick_skip_delivery_count, stats.exploration_delivery_count,
        stats.exploration_success_count, stats.engagement_depth, stats.attention_seconds_norm,
        stats.meaningful_engagement_rate
      ) IS DISTINCT FROM (
        EXCLUDED.served_delivery_count, EXCLUDED.rendered_count, EXCLUDED.video_start_count,
        EXCLUDED.video_half_completion_count, EXCLUDED.video_completion_count,
        EXCLUDED.attention_ms_total, EXCLUDED.attention_delivery_count,
        EXCLUDED.meaningful_engagement_count, EXCLUDED.quick_skip_delivery_count,
        EXCLUDED.exploration_delivery_count, EXCLUDED.exploration_success_count,
        EXCLUDED.engagement_depth, EXCLUDED.attention_seconds_norm,
        EXCLUDED.meaningful_engagement_rate
      );

  RETURN cardinality(v_post_ids);
END;
$function$;

COMMIT;

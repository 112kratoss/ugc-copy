-- refresh_post_feed_stats refreshes only the posts whose rows can change, and writes only the rows
-- that change (database audit, 2026-11-27).
--
-- Production: 3,329 calls at 284 ms, and 685,527 updates of post_feed_stats for 258 rows. Its
-- candidate step kept every post that had ever had a row (existing.post_id IS NOT NULL OR a recent
-- event), so no post ever left, and its ON CONFLICT rewrote all three window rows unconditionally.
--
-- Candidates now: a qualifying event in the last 31 days (the windows slide with no new event, so
-- "new events only" would be wrong), rows that are not yet what an empty window computes (a post
-- whose events have left every window gets one final refresh that zeroes it, and a row the
-- engagement refresh created gets its event columns, both as before), or a missing window row.
-- A post outside all three is skipped; on the same data its rows already equal what the old
-- function would write.
--
-- Rotation: the least recently refreshed posts still come first. Each refresh now keeps a cursor
-- of its own: stats_refreshed_at here, engagement_refreshed_at in
-- refresh_post_feed_engagement_stats (both added below). They used to share updated_at, and the
-- two run back to back at the same p_as_of, so one refresh's writes reordered the other's
-- rotation: posts the event refresh wrote every run sorted last for the engagement refresh and,
-- tied on post id, could miss it for good (review, 2026-11-27). The cursor is read on the 24h row,
-- which this refresh writes every time; the 7d and 30d rows are written only when a value changed
-- (IS DISTINCT FROM, as rebuild_search_terms does). So an unchanged post costs one row write
-- instead of three, and the cursor still advances, so the rotation reaches every candidate within
-- ceil(candidates / p_limit) runs, whatever the other refresh writes. updated_at stays "last
-- written"; nothing orders by it any more.
--
-- The return value is the number of posts refreshed, as before (it was rows / 3).
-- Name, arguments, return type, invoker rights, search_path and grants are unchanged; the body is
-- the live definition from a clean replay with the candidate step and the write guard changed.
-- supabase/tests/database/post_feed_stats_refresh_incremental.test.sql proves identical rows
-- against the old function, the zeroing, the skipped writes and the rotation.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- One rotation cursor per refresh. Nullable, no default: adding them rewrites nothing. They start
-- from updated_at, the marker both refreshes ordered by until now, so the first runs after this
-- keep the order they had.
ALTER TABLE public.post_feed_stats
  ADD COLUMN stats_refreshed_at timestamp with time zone,
  ADD COLUMN engagement_refreshed_at timestamp with time zone;

COMMENT ON COLUMN public.post_feed_stats.stats_refreshed_at IS
  'When refresh_post_feed_stats last refreshed the post (read on the 24h row): its rotation cursor.';
COMMENT ON COLUMN public.post_feed_stats.engagement_refreshed_at IS
  'When refresh_post_feed_engagement_stats last refreshed the post (read on the 24h row): its rotation cursor.';

UPDATE public.post_feed_stats
SET stats_refreshed_at = updated_at,
    engagement_refreshed_at = updated_at;

CREATE OR REPLACE FUNCTION public.refresh_post_feed_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_post_ids uuid[];
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

  -- A candidate is a post whose rows can change: one with a qualifying event in the last 31 days
  -- (its windows slide even with no new event), one whose rows are not yet what an empty window
  -- computes (it needs one final refresh to zero them; this also gives the event columns to a row
  -- the engagement refresh created), or one missing a window row. Nothing else: a post whose rows
  -- are all empty stays as it is until a new event arrives.
  SELECT array_agg(candidate.post_id ORDER BY candidate.last_refreshed_at ASC NULLS FIRST, candidate.post_id)
  INTO v_post_ids
  FROM (
    SELECT changing.post_id, marker.stats_refreshed_at AS last_refreshed_at
    FROM (
      SELECT p.id AS post_id
      FROM public.posts AS p
      WHERE EXISTS (
        SELECT 1
        FROM public.feed_events AS recent_event
        WHERE recent_event.post_id = p.id
          AND (
            recent_event.delivery_fact_id IS NOT NULL
            OR recent_event.event_type IN ('comment', 'follow', 'remix_complete', 'purchase')
          )
          AND recent_event.occurred_at >= p_as_of - interval '31 days'
          AND recent_event.occurred_at <= p_as_of
      )

      UNION

      SELECT stale.post_id
      FROM public.post_feed_stats AS stale
      WHERE (
        stale.impression_count, stale.unique_viewer_count, stale.open_count, stale.dwell_ms,
        stale.media_progress_count, stale.quick_skip_count, stale.save_count, stale.share_count,
        stale.comment_count, stale.follow_count, stale.remix_start_count, stale.remix_complete_count,
        stale.resource_open_count, stale.purchase_count, stale.not_interested_count,
        stale.hide_creator_count, stale.report_count,
        stale.usefulness_score, stale.quick_skip_rate, stale.negative_feedback_rate,
        stale.last_event_at, stale.last_event_received_at
      ) IS DISTINCT FROM (
        0::bigint, 0::bigint, 0::bigint, 0::bigint,
        0::bigint, 0::bigint, 0::bigint, 0::bigint,
        0::bigint, 0::bigint, 0::bigint, 0::bigint,
        0::bigint, 0::bigint, 0::bigint,
        0::bigint, 0::bigint,
        -- The scores of an empty window, by the expressions below with every count 0.
        least(1.0::double precision, 2.0::double precision / 25.0::double precision),
        least(1.0::double precision, 1.25::double precision / 5.0::double precision),
        least(1.0::double precision, 0.2::double precision / 20.0::double precision),
        NULL::timestamptz, NULL::timestamptz
      )

      UNION

      SELECT partial.post_id
      FROM public.post_feed_stats AS partial
      GROUP BY partial.post_id
      HAVING count(*) < 3
    ) AS changing
    -- This refresh's own cursor, on the 24h row it writes every time: the least recently refreshed
    -- come first, posts with no row (or never refreshed here) before all. The engagement refresh
    -- keeps a cursor of its own, so its writes never reorder this rotation.
    LEFT JOIN public.post_feed_stats AS marker
      ON marker.post_id = changing.post_id
     AND marker.window_key = '24h'
    ORDER BY marker.stats_refreshed_at ASC NULLS FIRST, changing.post_id
    LIMIT p_limit
  ) AS candidate;

  IF coalesce(cardinality(v_post_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  WITH windows(window_key, duration) AS (
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
      count(events.id) FILTER (WHERE events.event_type = 'comment')::bigint AS comment_count,
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
    FROM unnest(v_post_ids) AS candidates(post_id)
    CROSS JOIN windows
    LEFT JOIN public.feed_events AS events
      ON events.post_id = candidates.post_id
     AND (
       events.delivery_fact_id IS NOT NULL
       OR events.event_type IN ('comment', 'follow', 'remix_complete', 'purchase')
     )
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
          + 1.00::double precision * raw.comment_count::double precision
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
    comment_count,
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
    updated_at,
    stats_refreshed_at
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
    scored.comment_count,
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
    p_as_of,
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
      comment_count = EXCLUDED.comment_count,
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
      updated_at = EXCLUDED.updated_at,
      stats_refreshed_at = EXCLUDED.stats_refreshed_at
  -- The 24h row always (it carries the cursor); the others only when a value changed.
  WHERE post_feed_stats.window_key = '24h'
     OR (
        post_feed_stats.impression_count, post_feed_stats.unique_viewer_count,
        post_feed_stats.open_count, post_feed_stats.dwell_ms, post_feed_stats.media_progress_count,
        post_feed_stats.quick_skip_count, post_feed_stats.save_count, post_feed_stats.share_count,
        post_feed_stats.comment_count, post_feed_stats.follow_count,
        post_feed_stats.remix_start_count, post_feed_stats.remix_complete_count,
        post_feed_stats.resource_open_count, post_feed_stats.purchase_count,
        post_feed_stats.not_interested_count, post_feed_stats.hide_creator_count,
        post_feed_stats.report_count, post_feed_stats.usefulness_score,
        post_feed_stats.quick_skip_rate, post_feed_stats.negative_feedback_rate,
        post_feed_stats.last_event_at, post_feed_stats.last_event_received_at
      ) IS DISTINCT FROM (
        EXCLUDED.impression_count, EXCLUDED.unique_viewer_count, EXCLUDED.open_count,
        EXCLUDED.dwell_ms, EXCLUDED.media_progress_count, EXCLUDED.quick_skip_count,
        EXCLUDED.save_count, EXCLUDED.share_count, EXCLUDED.comment_count, EXCLUDED.follow_count,
        EXCLUDED.remix_start_count, EXCLUDED.remix_complete_count, EXCLUDED.resource_open_count,
        EXCLUDED.purchase_count, EXCLUDED.not_interested_count, EXCLUDED.hide_creator_count,
        EXCLUDED.report_count, EXCLUDED.usefulness_score, EXCLUDED.quick_skip_rate,
        EXCLUDED.negative_feedback_rate, EXCLUDED.last_event_at, EXCLUDED.last_event_received_at
      );

  RETURN cardinality(v_post_ids);
END;
$function$;

COMMIT;

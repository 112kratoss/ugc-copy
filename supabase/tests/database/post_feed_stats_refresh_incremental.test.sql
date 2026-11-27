-- refresh_post_feed_stats refreshes only the posts whose rows can change, and leaves rows whose
-- values did not change unwritten (database audit, 2026-11-27).
--
-- Before, every post that had ever had a post_feed_stats row stayed a candidate forever and all
-- three window rows were rewritten on every run. A candidate is now a post with a qualifying
-- event in the last 31 days, or one whose rows are not yet what an empty window computes (it
-- needs one final refresh to zero them), or one missing a window row. The 24h row is always
-- written: its updated_at is the refresh marker the rotation orders by. The 7d and 30d rows are
-- written only when a value changed.
--
-- The oracle is the old function, kept below as pg_temp.legacy_refresh_post_feed_stats: on the
-- same data both must leave identical values in every row and window.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

-- The function as it was before this change (pg_get_functiondef on a clean replay), the oracle.
CREATE FUNCTION pg_temp.legacy_refresh_post_feed_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
          AND (
            recent_event.delivery_fact_id IS NOT NULL
            OR recent_event.event_type IN ('comment', 'follow', 'remix_complete', 'purchase')
          )
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
    FROM candidate_posts AS candidates
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
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$function$;

-- What the function keeps: invoker rights, search path, grants.
select ok(not (select prosecdef from pg_proc where oid = 'public.refresh_post_feed_stats(timestamptz,integer)'::regprocedure), 'still invoker');
select is((select proconfig from pg_proc where oid = 'public.refresh_post_feed_stats(timestamptz,integer)'::regprocedure), array['search_path=public, pg_temp'], 'same search path');
select ok(has_function_privilege('service_role', 'public.refresh_post_feed_stats(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.refresh_post_feed_stats(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.refresh_post_feed_stats(timestamptz,integer)', 'EXECUTE'), 'same grants');
select is(pg_get_function_result('public.refresh_post_feed_stats(timestamptz,integer)'::regprocedure), 'integer', 'same return type');

-- Runs the old function from the current rows and keeps what it wrote, puts the rows back, runs the
-- new one, and answers how many rows differ in any column but updated_at (0 = identical).
create function pg_temp.diff_against_legacy(p_as_of timestamptz) returns bigint language plpgsql as $$
declare v_diff bigint;
begin
  drop table if exists pg_temp.before_state, pg_temp.legacy_state;
  create temp table before_state as select * from public.post_feed_stats;
  perform pg_temp.legacy_refresh_post_feed_stats(p_as_of, 10000);
  create temp table legacy_state as select to_jsonb(s) - 'updated_at' as v from public.post_feed_stats s;
  delete from public.post_feed_stats;
  insert into public.post_feed_stats select * from before_state;
  perform public.refresh_post_feed_stats(p_as_of, 10000);
  select count(*) into v_diff from (
    (select v from legacy_state except all select to_jsonb(s) - 'updated_at' from public.post_feed_stats s)
    union all
    (select to_jsonb(s) - 'updated_at' from public.post_feed_stats s except all select v from legacy_state)
  ) d;
  return v_diff;
end $$;

create function pg_temp.post(n int) returns uuid language sql immutable as $$
  select ('5c000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.ctids(n int) returns text language sql as $$
  select string_agg(window_key || ctid::text, ',' order by window_key) from public.post_feed_stats where post_id = pg_temp.post($1) $$;

insert into auth.users (id, email, aud, role, created_at) values
  ('5c100000-0000-4000-8000-000000000001', 'stats-creator@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5c100000-0000-4000-8000-000000000002', 'stats-viewer-a@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5c100000-0000-4000-8000-000000000003', 'stats-viewer-b@example.invalid', 'authenticated', 'authenticated', '1900-01-01');

-- Posts 1-12: 1 active in every window, 2 aged out of all windows, 3 only inside the 31-day
-- slack, 4 one event ten days old, 5 a row the engagement refresh made (its own columns at their
-- defaults), 6 nothing at all, 7-12 one event five days old each.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body, created_at)
select pg_temp.post(n), '5c100000-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'visible', 'stats ' || n, '2029-01-01'
from generate_series(1, 12) n;

create temp table clock as select timestamptz '2030-03-01 00:00:00+00' as t;

-- Events skip their context triggers here: the refresh reads only these columns.
set local session_replication_role = replica;
insert into public.feed_events (client_event_id, post_id, creator_user_id, viewer_user_id, anonymous_key_hash, event_type, source_surface, occurred_at, received_at, duration_ms, delivery_fact_id)
select 'stats-' || row_number() over (), pg_temp.post(e.n), '5c100000-0000-4000-8000-000000000001',
  case when e.viewer = 'anon' then null else ('5c100000-0000-4000-8000-00000000000' || e.viewer)::uuid end,
  case when e.viewer = 'anon' then repeat('a', 64) end,
  e.kind, 'feed', clock.t - e.age, clock.t - e.age, e.duration, case when e.delivered then 1 end
from clock, (values
  (1, 'impression', interval '1 hour', '2', null::int, true),
  (1, 'impression', interval '1 hour', '3', null, true),
  (1, 'impression', interval '2 hours', 'anon', null, true),
  (1, 'open', interval '2 hours', '2', null, true),
  (1, 'dwell', interval '3 hours', '2', 5000, true),
  (1, 'save', interval '3 days', '3', null, true),
  (1, 'share', interval '6 days', '2', null, true),
  (1, 'impression', interval '6 days', '2', null, false),   -- no delivery and not a direct signal: never counted
  (1, 'comment', interval '10 days', '3', null, false),
  (1, 'follow', interval '20 days', '2', null, false),
  (1, 'purchase', interval '29 days', '3', null, false),
  (1, 'report', interval '30 days 12 hours', '2', null, true),
  (1, 'quick_skip', interval '40 days', '3', null, true),
  (1, 'remix_complete', interval '-5 minutes', '2', null, false), -- ahead of the clock
  (2, 'comment', interval '40 days', '2', null, false),
  (2, 'impression', interval '45 days', '3', null, true),
  (3, 'comment', interval '30 days 12 hours', '2', null, false),
  (4, 'comment', interval '10 days', '2', null, false),
  (7, 'comment', interval '5 days', '2', null, false),
  (8, 'comment', interval '5 days', '2', null, false),
  (9, 'comment', interval '5 days', '2', null, false),
  (10, 'comment', interval '5 days', '2', null, false),
  (11, 'comment', interval '5 days', '2', null, false),
  (12, 'comment', interval '5 days', '2', null, false)
) as e(n, kind, age, viewer, duration, delivered);
set local session_replication_role = origin;

-- Post 5's rows as the engagement refresh writes them for a post with no events.
insert into public.post_feed_stats (post_id, window_key, served_delivery_count, rendered_count, updated_at)
select pg_temp.post(5), w, 3, 2, '2030-01-01' from unnest(array['24h', '7d', '30d']) w;

-- The state an earlier run left: the old function, fifteen days before the clock, when post 2's
-- events were still inside the 30-day window.
select pg_temp.legacy_refresh_post_feed_stats((select t from clock) - interval '15 days', 10000);
select ok((select impression_count + comment_count from public.post_feed_stats where post_id = pg_temp.post(2) and window_key = '30d') = 2,
  'fixture: post 2 holds counts from fifteen days ago');

-- 1. Identical to the old function at the clock: active windows, the slack, the aged-out post
--    zeroed, the engagement-only row given its event columns.
select is(pg_temp.diff_against_legacy((select t from clock)), 0::bigint, 'identical to the old function at the clock');
select is((select sum(impression_count + comment_count + quick_skip_count)::int from public.post_feed_stats where post_id = pg_temp.post(2)), 0,
  'the aged-out post is zeroed');
select is((select count(*)::int from public.post_feed_stats where post_id = pg_temp.post(6)), 0, 'a post with nothing gets no rows');
select is(
  (select array_agg(impression_count::text || '/' || open_count || '/' || dwell_ms || '/' || save_count || '/' || share_count || '/' || comment_count || '/' || follow_count || '/' || purchase_count || '/' || report_count || '/' || quick_skip_count || '/' || remix_complete_count order by window_key)
   from public.post_feed_stats where post_id = pg_temp.post(1)),
  array['3/1/5000/0/0/0/0/0/0/0/0', '3/1/5000/1/1/1/1/1/0/0/0', '3/1/5000/1/1/0/0/0/0/0/0'],
  'post 1 counts each window''s events (24h, 30d, 7d)');

-- 2. A minute later: the aged-out post and post 5 are no longer candidates and are not written;
--    the unchanged post's 7d and 30d rows are not written; its 24h row carries the marker.
create temp table before_minute as
select post_id, window_key, ctid::text as tid, updated_at from public.post_feed_stats;
select is(public.refresh_post_feed_stats((select t from clock) + interval '1 minute', 10000), 9,
  'nine candidates: posts 1, 3, 4 and 7-12');
select ok(not exists (
  select 1 from public.post_feed_stats s join before_minute b using (post_id, window_key)
  where s.post_id in (pg_temp.post(2), pg_temp.post(5)) and (s.ctid::text <> b.tid or s.updated_at <> b.updated_at)),
  'the zeroed post and the engagement-only post are not rewritten');
select ok(not exists (
  select 1 from public.post_feed_stats s join before_minute b using (post_id, window_key)
  where s.post_id = pg_temp.post(4) and s.window_key in ('7d', '30d') and s.ctid::text <> b.tid),
  'an unchanged post''s 7d and 30d rows are not rewritten');
select is((select updated_at from public.post_feed_stats where post_id = pg_temp.post(4) and window_key = '24h'),
  (select t from clock) + interval '1 minute', 'its 24h row carries the refresh marker');

-- 3. Rotation: nine candidates, four a run. Three runs reach every candidate, least recently
--    refreshed first, although most rows do not change and are not written.
create temp table candidates as select pg_temp.post(n) as post_id from unnest(array[1, 3, 4, 7, 8, 9, 10, 11, 12]) n;
update public.post_feed_stats set updated_at = '2030-02-01' where window_key = '24h' and post_id = pg_temp.post(12);
select is(public.refresh_post_feed_stats((select t from clock) + interval '2 minutes', 4), 4, 'run 1 takes four');
select is((select updated_at from public.post_feed_stats where window_key = '24h' and post_id = pg_temp.post(12)),
  (select t from clock) + interval '2 minutes', 'run 1 took the least recently refreshed first');
select is(public.refresh_post_feed_stats((select t from clock) + interval '3 minutes', 4), 4, 'run 2 takes four');
select is(public.refresh_post_feed_stats((select t from clock) + interval '4 minutes', 4), 4, 'run 3 takes four');
select is(
  (select count(*)::int from candidates c join public.post_feed_stats s on s.post_id = c.post_id and s.window_key = '24h'
   where s.updated_at >= (select t from clock) + interval '2 minutes'),
  9, 'three runs of four reached all nine candidates');

-- 4. Sliding windows with no new events: identical a day later (the first hours leave 24h), at
--    eight days (the 7d window empties for most), and at forty days (everything ages out).
select is(pg_temp.diff_against_legacy((select t from clock) + interval '25 hours'), 0::bigint, 'identical a day later');
select is((select impression_count::int from public.post_feed_stats where post_id = pg_temp.post(1) and window_key = '24h'), 0,
  'post 1''s 24h window emptied with no new event');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '8 days'), 0::bigint, 'identical at eight days');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '40 days'), 0::bigint, 'identical at forty days');
select is(public.refresh_post_feed_stats((select t from clock) + interval '40 days 1 minute', 10000), 0,
  'once everything is zeroed nothing is a candidate');

-- 5. A new event makes a zeroed post a candidate again, and the result still matches.
set local session_replication_role = replica;
insert into public.feed_events (client_event_id, post_id, creator_user_id, viewer_user_id, event_type, source_surface, occurred_at, received_at)
select 'stats-late', pg_temp.post(2), '5c100000-0000-4000-8000-000000000001', '5c100000-0000-4000-8000-000000000002', 'comment', 'feed',
  t + interval '39 days', t + interval '39 days' from clock;
set local session_replication_role = origin;
select is(pg_temp.diff_against_legacy((select t from clock) + interval '40 days 2 minutes'), 0::bigint, 'identical after a new event');

select * from finish();
rollback;

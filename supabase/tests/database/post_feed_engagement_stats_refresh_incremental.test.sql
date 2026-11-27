-- refresh_post_feed_engagement_stats reads the 30-day facts once, refreshes only the posts whose
-- rows can change, and leaves unchanged rows unwritten (database audit, 2026-11-27).
--
-- Before, its candidate step joined the 31-day facts to all three window rows of post_feed_stats,
-- and its rollup read each candidate's facts once per window. A post whose facts aged past 31
-- days without a refresh in the last day kept its counts for good. A candidate is now a post with
-- a fact in the last 31 days or one whose engagement counts are not all zero; the 24h row is
-- always written (it carries engagement_refreshed_at, the rotation's cursor), the 7d and 30d
-- rows only when a value changed. The cursors are left out of the comparison: the old function
-- had none.
--
-- The oracle is the old function, kept below as pg_temp.legacy_refresh_post_feed_engagement_stats.
-- Where the old function refreshes a post, both must leave identical values; where it left stale
-- counts (no fact in 31 days), the new one leaves what an empty window computes.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(25);

-- The function as it was before this change (pg_get_functiondef on a clean replay), the oracle.
CREATE FUNCTION pg_temp.legacy_refresh_post_feed_engagement_stats(p_as_of timestamp with time zone DEFAULT timezone('utc'::text, now()), p_limit integer DEFAULT 1000)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

select ok(not (select prosecdef from pg_proc where oid = 'public.refresh_post_feed_engagement_stats(timestamptz,integer)'::regprocedure), 'still invoker');
select is((select proconfig from pg_proc where oid = 'public.refresh_post_feed_engagement_stats(timestamptz,integer)'::regprocedure), array['search_path=public, pg_temp'], 'same search path');
select ok(has_function_privilege('service_role', 'public.refresh_post_feed_engagement_stats(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.refresh_post_feed_engagement_stats(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.refresh_post_feed_engagement_stats(timestamptz,integer)', 'EXECUTE'), 'same grants');
select is(pg_get_function_result('public.refresh_post_feed_engagement_stats(timestamptz,integer)'::regprocedure), 'integer', 'same return type');

-- The engagement columns of a row as text, and of a window with no facts.
create function pg_temp.engagement(s public.post_feed_stats) returns jsonb language sql as $$
  select jsonb_build_object('post_id', s.post_id, 'window_key', s.window_key,
    'served', s.served_delivery_count, 'rendered', s.rendered_count, 'video_start', s.video_start_count,
    'video_half', s.video_half_completion_count, 'video_completion', s.video_completion_count,
    'attention_ms', s.attention_ms_total, 'attention_deliveries', s.attention_delivery_count,
    'meaningful', s.meaningful_engagement_count, 'quick_skips', s.quick_skip_delivery_count,
    'exploration', s.exploration_delivery_count, 'exploration_success', s.exploration_success_count,
    'depth', s.engagement_depth, 'attention_norm', s.attention_seconds_norm, 'meaningful_rate', s.meaningful_engagement_rate) $$;
create function pg_temp.is_empty_window(s public.post_feed_stats) returns boolean language sql as $$
  select (pg_temp.engagement(s) - 'post_id' - 'window_key') = jsonb_build_object(
    'served', 0, 'rendered', 0, 'video_start', 0, 'video_half', 0, 'video_completion', 0,
    'attention_ms', 0, 'attention_deliveries', 0, 'meaningful', 0, 'quick_skips', 0, 'exploration', 0,
    'exploration_success', 0, 'depth', least(1.0::float8, 1.5::float8 / 6.0::float8), 'attention_norm', 0.0::float8,
    'meaningful_rate', least(1.0::float8, 2.0::float8 / 12.0::float8)) $$;
create function pg_temp.has_counts(s public.post_feed_stats) returns boolean language sql as $$
  select (s.served_delivery_count + s.rendered_count + s.video_start_count + s.video_half_completion_count
    + s.video_completion_count + s.attention_ms_total + s.attention_delivery_count + s.meaningful_engagement_count
    + s.quick_skip_delivery_count + s.exploration_delivery_count + s.exploration_success_count) > 0 $$;

-- Runs the old function from the current rows and keeps what it wrote, puts the rows back, runs
-- the new one, and answers how many rows differ: rows of posts the old function refreshed must be
-- identical in every column but updated_at; a post it left stale (counts left, no fact in 31
-- days) must now hold an empty window's values. 0 = both hold.
create function pg_temp.diff_against_legacy(p_as_of timestamptz) returns bigint language plpgsql as $$
declare v_diff bigint;
begin
  drop table if exists pg_temp.before_state, pg_temp.legacy_state, pg_temp.left_stale;
  create temp table before_state as select * from public.post_feed_stats;
  create temp table left_stale as
    select distinct s.post_id from public.post_feed_stats s
    where pg_temp.has_counts(s)
      and not exists (select 1 from public.feed_delivery_facts f where f.post_id = s.post_id
        and f.ranked_at >= p_as_of - interval '31 days' and f.ranked_at <= p_as_of);
  perform pg_temp.legacy_refresh_post_feed_engagement_stats(p_as_of, 10000);
  create temp table legacy_state as select to_jsonb(s) - 'updated_at' - 'stats_refreshed_at' - 'engagement_refreshed_at' as v from public.post_feed_stats s
    where s.post_id not in (select post_id from left_stale);
  delete from public.post_feed_stats;
  insert into public.post_feed_stats select * from before_state;
  perform public.refresh_post_feed_engagement_stats(p_as_of, 10000);
  select count(*) into v_diff from (
    (select v from legacy_state
     except all select to_jsonb(s) - 'updated_at' - 'stats_refreshed_at' - 'engagement_refreshed_at' from public.post_feed_stats s where s.post_id not in (select post_id from left_stale))
    union all
    (select to_jsonb(s) - 'updated_at' - 'stats_refreshed_at' - 'engagement_refreshed_at' from public.post_feed_stats s where s.post_id not in (select post_id from left_stale)
     except all select v from legacy_state)
    union all
    (select to_jsonb(s) from public.post_feed_stats s where s.post_id in (select post_id from left_stale) and not pg_temp.is_empty_window(s))
  ) d;
  return v_diff;
end $$;

create function pg_temp.post(n int) returns uuid language sql immutable as $$
  select ('5d000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

insert into auth.users (id, email, aud, role, created_at) values
  ('5d100000-0000-4000-8000-000000000001', 'engagement-creator@example.invalid', 'authenticated', 'authenticated', '1900-01-01');

-- Posts 1-12: 1 a video with facts in every window, 2 an image whose facts aged out, 3 an image
-- with a fact only inside the 31-day slack, 4 an image with one fact ten days old, 5 a row the
-- event refresh made (its own columns at their defaults), 6 nothing, 7-12 a fact five days old.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, output_url, created_at)
select pg_temp.post(n), '5d100000-0000-4000-8000-000000000001', 'public', case when n = 1 then 'video' else 'image' end,
  'external', 'media', 'visible', 'https://example.invalid/' || n, '2029-01-01'
from generate_series(1, 12) n;

create temp table clock as select timestamptz '2030-03-01 00:00:00+00' as t;

-- Facts skip their foreign keys and triggers here: the refresh reads only these columns.
set local session_replication_role = replica;
insert into public.feed_delivery_facts (delivery_id, session_id, algorithm_version_id, post_id, position, candidate_source, final_score,
  surface, mode, ranked_at, served_at, rendered_at, media_progress_max, media_duration_ms, dwell_ms_max, quick_skipped_at, is_exploration, saved_at, anonymous_key_hash)
select 5500000000 + row_number() over (), gen_random_uuid(), gen_random_uuid(), pg_temp.post(f.n), 0, 'fresh', 0.5, 'feed', 'for_you',
  clock.t - f.age, clock.t - f.age, case when f.rendered then clock.t - f.age end,
  f.progress, f.duration, f.dwell, case when f.skipped then clock.t - f.age end, f.explore,
  case when f.saved then clock.t - f.age end, repeat('e', 64)
from clock, (values
  (1, interval '1 hour', true, 0.6::float8, 10000, 0::bigint, false, false, false),
  (1, interval '2 hours', true, 0.97, 10000, 0, false, true, false),
  (1, interval '2 hours', true, 0.3, null, 0, false, false, false),
  (1, interval '3 days', true, 0.1, 10000, 0, true, false, false),
  (1, interval '10 days', false, 0, null, 0, false, false, false),
  (1, interval '20 days', true, 0.5, 8000, 0, false, true, true),
  (1, interval '30 days 12 hours', true, 1.0, 10000, 0, false, false, false),
  (1, interval '40 days', true, 1.0, 10000, 0, false, false, false),
  (1, interval '-5 minutes', true, 1.0, 10000, 0, false, false, false),
  (2, interval '40 days', true, 0, null, 5000, false, false, true),
  (3, interval '30 days 12 hours', true, 0, null, 4000, false, false, false),
  (4, interval '10 days', true, 0, null, 4000, false, false, false),
  (7, interval '5 days', true, 0, null, 1000, false, false, false),
  (8, interval '5 days', true, 0, null, 1000, false, false, false),
  (9, interval '5 days', true, 0, null, 1000, false, false, false),
  (10, interval '5 days', true, 0, null, 1000, false, false, false),
  (11, interval '5 days', true, 0, null, 1000, false, false, false),
  (12, interval '5 days', true, 0, null, 1000, false, false, false)
) as f(n, age, rendered, progress, duration, dwell, skipped, explore, saved);
set local session_replication_role = origin;

-- Post 5's rows as the event refresh writes them for a post with no facts.
insert into public.post_feed_stats (post_id, window_key, impression_count, usefulness_score, updated_at)
select pg_temp.post(5), w, 2, 0.08, '2030-01-01' from unnest(array['24h', '7d', '30d']) w;

-- The state an earlier run left: the old function fifteen days before the clock, when post 2's
-- fact was still inside the 30-day window.
select pg_temp.legacy_refresh_post_feed_engagement_stats((select t from clock) - interval '15 days', 10000);
select is((select rendered_count::int from public.post_feed_stats where post_id = pg_temp.post(2) and window_key = '30d'), 1,
  'fixture: post 2 holds counts from fifteen days ago');

-- 1. At the clock: identical where the old function refreshes; post 2, which the old function
--    would leave with its counts for good, is zeroed like post 3 (whose fact is in the slack).
select is(pg_temp.diff_against_legacy((select t from clock)), 0::bigint, 'identical to the old function at the clock, post 2 zeroed');
select ok((select bool_and(pg_temp.is_empty_window(s)) from public.post_feed_stats s where s.post_id in (pg_temp.post(2), pg_temp.post(3))),
  'posts 2 and 3 hold an empty window''s values');
select is((select array_agg(engagement_depth order by window_key) from public.post_feed_stats where post_id = pg_temp.post(5)),
  array[0, 0, 0]::float8[], 'a row with no facts and no counts is left alone, as before');
select is((select count(*)::int from public.post_feed_stats where post_id = pg_temp.post(6)), 0, 'a post with nothing gets no rows');
select is(
  (select array_agg(served_delivery_count::text || '/' || rendered_count || '/' || video_start_count || '/' || video_half_completion_count || '/' || video_completion_count || '/' || quick_skip_delivery_count || '/' || exploration_delivery_count || '/' || exploration_success_count || '/' || attention_delivery_count order by window_key)
   from public.post_feed_stats where post_id = pg_temp.post(1)),
  array['3/3/3/2/1/0/1/1/2', '6/5/5/3/1/1/2/2/4', '4/4/4/2/1/1/1/1/3'],
  'post 1 counts each window''s facts (24h, 30d, 7d)');

-- 2. A minute later: posts 2 and 5 are not candidates and are not written; the unchanged post's
--    7d and 30d rows are not written; its 24h row carries the cursor.
create temp table before_minute as
select post_id, window_key, ctid::text as tid, updated_at from public.post_feed_stats;
select is(public.refresh_post_feed_engagement_stats((select t from clock) + interval '1 minute', 10000), 9,
  'nine candidates: posts 1, 3, 4 and 7-12');
select ok(not exists (
  select 1 from public.post_feed_stats s join before_minute b using (post_id, window_key)
  where s.post_id in (pg_temp.post(2), pg_temp.post(5)) and (s.ctid::text <> b.tid or s.updated_at <> b.updated_at)),
  'the zeroed post and the event-only post are not rewritten');
select ok(not exists (
  select 1 from public.post_feed_stats s join before_minute b using (post_id, window_key)
  where s.post_id = pg_temp.post(4) and s.window_key in ('7d', '30d') and s.ctid::text <> b.tid),
  'an unchanged post''s 7d and 30d rows are not rewritten');
select is((select engagement_refreshed_at from public.post_feed_stats where post_id = pg_temp.post(4) and window_key = '24h'),
  (select t from clock) + interval '1 minute', 'its 24h row carries this refresh''s cursor');

-- 3. Rotation: nine candidates, four a run; three runs reach every one, least recently refreshed first.
create temp table candidates as select pg_temp.post(n) as post_id from unnest(array[1, 3, 4, 7, 8, 9, 10, 11, 12]) n;
update public.post_feed_stats set engagement_refreshed_at = '2030-02-01' where window_key = '24h' and post_id = pg_temp.post(12);
select is(public.refresh_post_feed_engagement_stats((select t from clock) + interval '2 minutes', 4), 4, 'run 1 takes four');
select is((select engagement_refreshed_at from public.post_feed_stats where window_key = '24h' and post_id = pg_temp.post(12)),
  (select t from clock) + interval '2 minutes', 'run 1 took the least recently refreshed first');
select is(public.refresh_post_feed_engagement_stats((select t from clock) + interval '3 minutes', 4), 4, 'run 2 takes four');
select is(public.refresh_post_feed_engagement_stats((select t from clock) + interval '4 minutes', 4), 4, 'run 3 takes four');
select is(
  (select count(*)::int from candidates c join public.post_feed_stats s on s.post_id = c.post_id and s.window_key = '24h'
   where s.engagement_refreshed_at >= (select t from clock) + interval '2 minutes'),
  9, 'three runs of four reached all nine candidates');

-- 4. Sliding windows with no new facts: a day later, at eight days, inside the slack of post 1's
--    newest facts, and once everything has aged out.
select is(pg_temp.diff_against_legacy((select t from clock) + interval '25 hours'), 0::bigint, 'identical a day later');
select is((select rendered_count::int from public.post_feed_stats where post_id = pg_temp.post(1) and window_key = '24h'), 0,
  'post 1''s 24h window emptied with no new fact');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '8 days'), 0::bigint, 'identical at eight days');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '30 days 6 hours'), 0::bigint, 'identical in the slack');
select is(pg_temp.diff_against_legacy((select t from clock) + interval '40 days'), 0::bigint, 'everything aged out is zeroed');
select is(public.refresh_post_feed_engagement_stats((select t from clock) + interval '40 days 1 minute', 10000), 0,
  'once everything is zeroed nothing is a candidate');

select * from finish();
rollback;

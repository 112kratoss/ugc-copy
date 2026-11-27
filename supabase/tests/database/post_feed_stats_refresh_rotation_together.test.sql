-- The two post_feed_stats refreshes run back to back at the same p_as_of in every feed upkeep run
-- (src/lib/feed-maintenance.ts). Each must rotate through its own candidates however the other
-- one writes the shared rows (database audit review, 2026-11-27): when they shared one marker,
-- the event refresh stamped its posts just before the engagement refresh, which then took the
-- unstamped posts first and broke the tie among the stamped ones by post id, so a high-id post
-- with steady events never had its engagement columns refreshed while engagement candidates
-- outnumbered the limit.
--
-- Fixture: posts 1-6 have facts (served, never rendered), so six engagement candidates; posts 5
-- and 6, the highest ids, also have events, so two event candidates. Limit 3 a run. After two
-- warm-up runs (the event refresh first gives its columns to rows the engagement refresh made),
-- each round adds one served fact to every post; two runs later, ceil(6 / 3), every post must
-- count it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

create function pg_temp.post(n int) returns uuid language sql immutable as $$
  select ('5f000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

insert into auth.users (id, email, aud, role, created_at) values
  ('5f100000-0000-4000-8000-000000000001', 'rotation-creator@example.invalid', 'authenticated', 'authenticated', '1900-01-01'),
  ('5f100000-0000-4000-8000-000000000002', 'rotation-viewer@example.invalid', 'authenticated', 'authenticated', '1900-01-01');
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, output_url, created_at)
select pg_temp.post(n), '5f100000-0000-4000-8000-000000000001', 'public', 'image', 'external', 'media', 'visible',
  'https://example.invalid/r' || n, '2029-01-01'
from generate_series(1, 6) n;

create temp table clock as select timestamptz '2030-03-01 00:00:00+00' as t;

set local session_replication_role = replica;
insert into public.feed_delivery_facts (delivery_id, session_id, algorithm_version_id, post_id, position, candidate_source, final_score,
  surface, mode, ranked_at, served_at, anonymous_key_hash)
select 5600000000 + n, gen_random_uuid(), gen_random_uuid(), pg_temp.post(n), 0, 'fresh', 0.5, 'feed', 'for_you',
  t - interval '2 days', t - interval '2 days', repeat('f', 64)
from clock, generate_series(1, 6) n;
insert into public.feed_events (client_event_id, post_id, creator_user_id, viewer_user_id, event_type, source_surface, occurred_at, received_at)
select 'rotation-' || n, pg_temp.post(n), '5f100000-0000-4000-8000-000000000001', '5f100000-0000-4000-8000-000000000002',
  'comment', 'feed', t - interval '1 day', t - interval '1 day'
from clock, generate_series(5, 6) n;
set local session_replication_role = origin;

-- One feed upkeep run: the event refresh, then the engagement refresh, at the same clock.
create function pg_temp.upkeep(p_run int) returns void language plpgsql as $$
declare v_as_of timestamptz := (select t from clock) + make_interval(hours => p_run);
begin
  perform public.refresh_post_feed_stats(v_as_of, 3);
  perform public.refresh_post_feed_engagement_stats(v_as_of, 3);
end $$;

-- One more served fact on every post, at the given hour.
create function pg_temp.serve_all(p_hour int) returns void language sql as $$
  insert into public.feed_delivery_facts (delivery_id, session_id, algorithm_version_id, post_id, position, candidate_source, final_score,
    surface, mode, ranked_at, served_at, anonymous_key_hash)
  select 5600000000 + p_hour * 100 + n, gen_random_uuid(), gen_random_uuid(), pg_temp.post(n), 0, 'fresh', 0.5, 'feed', 'for_you',
    t + make_interval(hours => p_hour), t + make_interval(hours => p_hour), repeat('f', 64)
  from clock, generate_series(1, 6) n $$;

create function pg_temp.posts_counting(p_served int) returns int[] language sql as $$
  select coalesce(array_agg(n order by n), '{}') from generate_series(1, 6) n
  where (select served_delivery_count from public.post_feed_stats where post_id = pg_temp.post(n) and window_key = '30d') = p_served $$;

select pg_temp.upkeep(1);
select pg_temp.upkeep(2);

set local session_replication_role = replica;
select pg_temp.serve_all(2);
set local session_replication_role = origin;
select pg_temp.upkeep(3);
select pg_temp.upkeep(4);
select is(pg_temp.posts_counting(2), array[1, 2, 3, 4, 5, 6], 'round 1: two runs of three reach all six engagement candidates');
select ok((select comment_count = 1 from public.post_feed_stats where post_id = pg_temp.post(6) and window_key = '30d'),
  'the highest-id post''s event columns are refreshed too');

set local session_replication_role = replica;
select pg_temp.serve_all(4);
set local session_replication_role = origin;
select pg_temp.upkeep(5);
select pg_temp.upkeep(6);
select is(pg_temp.posts_counting(3), array[1, 2, 3, 4, 5, 6], 'round 2: again all six within two runs');

set local session_replication_role = replica;
select pg_temp.serve_all(6);
set local session_replication_role = origin;
select pg_temp.upkeep(7);
select pg_temp.upkeep(8);
select is(pg_temp.posts_counting(4), array[1, 2, 3, 4, 5, 6], 'round 3: again all six within two runs');

select * from finish();
rollback;

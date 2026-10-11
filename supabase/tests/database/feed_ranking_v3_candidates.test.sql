-- Feed ranking v3 (20261011170309_feed_ranking_v3_x_adoption.sql).
--
-- Retrieval: the safety exclusions now happen in SQL, before ranking and
-- before any session slot or delivery fact is spent on them; served and seen
-- are kept apart; the cold pool finds new posts by unexposed authors; trending
-- is capped per author. Operations: activation swaps statuses in one
-- transaction, refuses an already active target and treats a retired one as a
-- rollback; an experiment's allocations must sum to exactly 10000; the
-- scorecard adds an all-sources row per version. Every RPC is called as
-- service_role, the only role allowed to, so missing table grants fail here.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(76);

-- ─── Surface ─────────────────────────────────────────────────────────────────

create temporary table v3_functions as
select unnest(array[
  'public.get_ranked_feed_candidates_v3(uuid,text,text,integer,integer,integer,integer,integer,integer,double precision,double precision,timestamptz,integer,integer,integer,integer,integer,integer,double precision)'::regprocedure,
  'public.activate_feed_algorithm_version(uuid)'::regprocedure,
  'public.create_feed_experiment(jsonb,jsonb)'::regprocedure,
  'public.set_feed_experiment_status(uuid,text)'::regprocedure,
  'public.feed_algorithm_scorecard(integer)'::regprocedure,
  'public.refresh_creator_feed_stats(timestamptz,integer)'::regprocedure,
  'public.refresh_post_feed_stats(timestamptz,integer)'::regprocedure
]) as fn;

select ok((select bool_and(has_function_privilege('service_role', fn, 'EXECUTE')) from v3_functions),
  'the service role can call every v3 function');
select ok((select bool_and(not has_function_privilege('anon', fn, 'EXECUTE')) from v3_functions),
  'anonymous clients cannot call any v3 function');
select ok((select bool_and(not has_function_privilege('authenticated', fn, 'EXECUTE')) from v3_functions),
  'signed-in clients cannot call any v3 function');
select ok((select bool_and(not p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'])
  from v3_functions join pg_proc as p on p.oid = v3_functions.fn),
  'every v3 function runs as its caller with a pinned search path');
select is((select status from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 3),
  'shadow', 'v3 is seeded as shadow, so deploying it serves nothing');
select is((select count(*)::integer from information_schema.columns
  where table_schema = 'public' and table_name = 'creator_feed_stats'
    and column_name in ('negative_feedback_count', 'negative_feedback_rate')),
  2, 'creator stats carry the negative-feedback count and rate');

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- Users: viewer V(1), followed F(2), blocked by the viewer B(3), blocking the
-- viewer R(4), other creator O(5), unexposed creator C(6), exposed creator
-- E(7), another reporter X(8).

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
select ('f3a00000-0000-4000-8000-00000000000' || n)::uuid,
  'feed-v3-' || n || '@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now() - interval '60 days'
from generate_series(1, 8) as n;

-- Posts f3b…NN. Text posts carry no media, so the NSFW one needs no private copy.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body, is_nsfw, created_at)
values
  ('f3b00000-0000-4000-8000-000000000001', 'f3a00000-0000-4000-8000-000000000002', 'public', 'text', 'external', 'text', 'visible', 'followed creator', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000002', 'f3a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'blocked by the viewer', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000003', 'f3a00000-0000-4000-8000-000000000004', 'public', 'text', 'external', 'text', 'visible', 'blocks the viewer', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'visible', 'the viewer''s own post', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000005', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'labelled mature', true, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000006', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'reported by the viewer', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'reported by others', false, now() - interval '3 days'),
  ('f3b00000-0000-4000-8000-000000000008', 'f3a00000-0000-4000-8000-000000000006', 'public', 'text', 'external', 'text', 'visible', 'new from an unexposed author', false, now() - interval '1 hour'),
  ('f3b00000-0000-4000-8000-000000000009', 'f3a00000-0000-4000-8000-000000000007', 'public', 'text', 'external', 'text', 'visible', 'new from an exposed author', false, now() - interval '1 hour'),
  ('f3b00000-0000-4000-8000-000000000010', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'served an hour ago, never seen', false, now() - interval '2 days'),
  ('f3b00000-0000-4000-8000-000000000011', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'older than the catalog bound', false, now() - interval '400 days'),
  ('f3b00000-0000-4000-8000-000000000012', 'f3a00000-0000-4000-8000-000000000005', 'public', 'text', 'external', 'text', 'visible', 'served seven hours ago', false, now() - interval '2 days'),
  ('f3b00000-0000-4000-8000-000000000013', 'f3a00000-0000-4000-8000-000000000007', 'public', 'text', 'external', 'text', 'visible', 'exposed author, slower', false, now() - interval '5 hours'),
  ('f3b00000-0000-4000-8000-000000000014', 'f3a00000-0000-4000-8000-000000000007', 'public', 'text', 'external', 'text', 'visible', 'exposed author, slowest', false, now() - interval '10 hours');

insert into public.follows (follower_id, following_id)
values ('f3a00000-0000-4000-8000-000000000001', 'f3a00000-0000-4000-8000-000000000002');

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('f3a00000-0000-4000-8000-000000000001', 'f3a00000-0000-4000-8000-000000000003'),
  ('f3a00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001');

-- Post 7: X reports it twice (one reporter), F's report was dismissed.
insert into public.post_reports (post_id, reporter_user_id, reason, status)
values
  ('f3b00000-0000-4000-8000-000000000006', 'f3a00000-0000-4000-8000-000000000001', 'spam', 'open'),
  ('f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000008', 'spam', 'open'),
  ('f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000008', 'other', 'open'),
  ('f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000002', 'spam', 'dismissed');

-- E has been rendered 100 times in 30 days, so its new posts are not cold.
insert into public.creator_feed_stats (creator_user_id, window_key, rendered_count, meaningful_engagement_count, post_count, quality_rate)
values ('f3a00000-0000-4000-8000-000000000007', '30d', 100, 50, 3, 0.5);

-- E's three posts all trend; by projected velocity 9 > 13 > 14.
insert into public.post_feed_stats (post_id, window_key, rendered_count, meaningful_engagement_count, meaningful_engagement_rate)
values
  ('f3b00000-0000-4000-8000-000000000009', '24h', 10, 5, 0.5),
  ('f3b00000-0000-4000-8000-000000000013', '24h', 10, 4, 0.4),
  ('f3b00000-0000-4000-8000-000000000014', '24h', 10, 1, 0.1),
  ('f3b00000-0000-4000-8000-000000000009', '30d', 40, 10, 0.25);

-- Algorithm versions of a fixture key, isolated from for-you-rules.
insert into public.feed_algorithm_versions (id, algorithm_key, version, status, activated_at)
values
  ('f3c00000-0000-4000-8000-000000000001', 'v3-pgtap-fixture', 1, 'active', now() - interval '1 day'),
  ('f3c00000-0000-4000-8000-000000000002', 'v3-pgtap-fixture', 2, 'shadow', null),
  ('f3c00000-0000-4000-8000-000000000003', 'v3-pgtap-fixture', 3, 'draft', null),
  ('f3c00000-0000-4000-8000-000000000004', 'v3-pgtap-fixture', 4, 'shadow', null);

-- Delivery facts. 1: served an hour ago, never rendered. 2: served seven hours
-- ago. 3 and 4: rendered two days ago, one answered "not interested", one held
-- for 4 s. 5: an anonymous viewer, half an hour ago.
insert into public.feed_delivery_facts (
  delivery_id, session_id, algorithm_version_id, viewer_user_id, anonymous_key_hash, post_id, creator_user_id,
  position, candidate_source, final_score, surface, mode, ranked_at, served_at, rendered_at, not_interested_at, dwell_ms_max
)
values
  (9300000001, gen_random_uuid(), 'f3c00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001', null,
   'f3b00000-0000-4000-8000-000000000010', 'f3a00000-0000-4000-8000-000000000005', 0, 'fresh', 0.5, 'feed', 'for-you',
   now() - interval '1 hour', now() - interval '1 hour', null, null, 0),
  (9300000002, gen_random_uuid(), 'f3c00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001', null,
   'f3b00000-0000-4000-8000-000000000012', 'f3a00000-0000-4000-8000-000000000005', 1, 'fresh', 0.5, 'feed', 'for-you',
   now() - interval '7 hours', now() - interval '7 hours', null, null, 0),
  (9300000003, gen_random_uuid(), 'f3c00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001', null,
   'f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000005', 0, 'trending', 0.5, 'feed', 'for-you',
   now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 0),
  (9300000004, gen_random_uuid(), 'f3c00000-0000-4000-8000-000000000004', 'f3a00000-0000-4000-8000-000000000001', null,
   'f3b00000-0000-4000-8000-000000000007', 'f3a00000-0000-4000-8000-000000000005', 1, 'trending', 0.5, 'feed', 'for-you',
   now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', null, 4000),
  (9300000005, gen_random_uuid(), 'f3c00000-0000-4000-8000-000000000004', null, repeat('a', 64),
   'f3b00000-0000-4000-8000-000000000008', 'f3a00000-0000-4000-8000-000000000006', 0, 'cold', 0.5, 'feed', 'for-you',
   now() - interval '30 minutes', now() - interval '30 minutes', null, null, 0);

-- A qualified impression of post 7 whose session was since pruned: no session
-- and no session item, only the immutable delivery snapshot (the fact itself
-- has aged out, so the outcome trigger finds nothing to update).
insert into public.feed_events (client_event_id, viewer_user_id, post_id, creator_user_id, event_type, source_surface, occurred_at, delivery_fact_id)
values ('feed-v3-detached-impression', 'f3a00000-0000-4000-8000-000000000001', 'f3b00000-0000-4000-8000-000000000007',
  'f3a00000-0000-4000-8000-000000000005', 'impression', 'feed', now() - interval '3 days', 9399999999);

-- ─── Candidates, signed in ───────────────────────────────────────────────────

create temporary table v3_signed_in as
select * from public.get_ranked_feed_candidates_v3() with no data;
create temporary table v3_anonymous as
select * from public.get_ranked_feed_candidates_v3() with no data;
grant select, insert on v3_signed_in, v3_anonymous to service_role;

set local role service_role;
insert into v3_signed_in
select * from public.get_ranked_feed_candidates_v3(
  p_viewer_user_id => 'f3a00000-0000-4000-8000-000000000001',
  p_as_of => now(),
  p_trending_per_author_cap => 2,
  p_creator_prior_cap => 1.0,
  p_creator_prior_mean => 0.3
);
insert into v3_anonymous
select * from public.get_ranked_feed_candidates_v3(
  p_anonymous_key_hash => repeat('a', 64),
  p_as_of => now()
);
reset role;

select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000002'),
  'a creator the viewer blocked is excluded before ranking');
select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000003'),
  'a creator who blocked the viewer is excluded before ranking');
select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000004'),
  'the viewer''s own post is excluded');
select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000005'),
  'an NSFW post is excluded');
select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000006'),
  'a post the viewer reported is excluded');
select ok(not exists(select 1 from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000011'),
  'a post older than max_age_days is outside the catalog bound');
select is((select count(*)::integer from v3_signed_in where post_id::text like 'f3b00000-%'), 8,
  'exactly the eight eligible fixture posts are candidates');

select ok((select is_following and candidate_source = 'following' and sources[1] = 'following'
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000001'),
  'a followed creator''s post is flagged and keeps following as its first source');
select ok((select not is_following from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000007'),
  'a creator the viewer does not follow is not flagged');

select ok((select sources @> '{cold}' and candidate_source = 'cold' and author_rendered_30d = 0
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000008'),
  'a one-hour-old post from an unexposed author comes from the cold pool');
select ok((select not (sources @> '{cold}') and author_rendered_30d = 100
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000009'),
  'a new post from an author rendered 100 times in 30 days is not cold');
select ok((select sources @> '{fresh}' from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000008'),
  'sources keeps every pool a post came from, not only the winner');
select ok((select bool_and(candidate_source = sources[1]) from v3_signed_in),
  'candidate_source is always the highest-priority source');

select ok((select served_recently and not seen_recently
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000010'),
  'a post served an hour ago but never seen is served, not seen');
select ok((select not served_recently from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000012'),
  'a delivery older than served_lookback_hours does not count as served');
select ok((select seen_recently and not served_recently
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000007'),
  'a qualified impression is seen even when its session is gone');

select is((select count(*)::integer from v3_signed_in
  where post_id in ('f3b00000-0000-4000-8000-000000000009', 'f3b00000-0000-4000-8000-000000000013',
    'f3b00000-0000-4000-8000-000000000014')
    and sources @> '{trending}'),
  2, 'trending takes at most trending_per_author_cap posts from one author');
select ok((select not (sources @> '{trending}') from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000014'),
  'the cap drops the author''s lowest-velocity post');
select ok((select relevant_trend > 0.4 and relevant_trend <= 0.5
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000009'),
  'a one-hour-old post''s projected renders saturate the volume factor, leaving its engagement rate');

select is((select reports_7d from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000007'),
  1::bigint, 'reports count once per reporter and ignore dismissed reports');
select ok((select abs(negative_feedback_risk - 2.2 / 20.0) < 1e-9
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000007'),
  'a report adds two negatives to the post''s smoothed risk');
select is((select creator_quality from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000008'),
  0.3::double precision, 'an unmeasured creator gets the prior mean, not zero');
select is((select creator_quality from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000009'),
  0.5::double precision, 'a measured creator gets its own quality rate under the cap');
select is((select post_rendered_30d || '/' || post_meaningful_30d
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000009'),
  '40/10', 'the 30-day rendered and meaningful counts come back raw');
select ok((select post_age_hours > 0.99 and post_age_hours < 1.01
  from v3_signed_in where post_id = 'f3b00000-0000-4000-8000-000000000008'),
  'post age is reported in hours');

-- ─── Candidates, signed out ──────────────────────────────────────────────────

select ok((select served_recently from v3_anonymous where post_id = 'f3b00000-0000-4000-8000-000000000008'),
  'a signed-out viewer''s deliveries are found by its key hash');
select ok((select bool_and(not is_following) from v3_anonymous),
  'nobody is followed when signed out');
select ok(exists(select 1 from v3_anonymous where post_id = 'f3b00000-0000-4000-8000-000000000002')
  and exists(select 1 from v3_anonymous where post_id = 'f3b00000-0000-4000-8000-000000000004'),
  'blocks and own-post exclusions belong to the viewer, not to the post');
select ok(not exists(select 1 from v3_anonymous where post_id = 'f3b00000-0000-4000-8000-000000000005'),
  'NSFW posts are excluded for everyone');

-- ─── Parameter bounds ────────────────────────────────────────────────────────

set local role service_role;
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_cold_limit => 501)$$,
  'P0001', 'Feed candidate pool limits must be between 0 and 500', 'the cold pool limit is bounded');
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_served_lookback_hours => 8761)$$,
  'P0001', 'Feed candidate hour windows must be between 0 and 8760', 'the served window is bounded');
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_max_age_days => 0)$$,
  'P0001', 'Feed candidate max age days must be between 1 and 3650', 'the catalog bound cannot be switched off');
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_trending_per_author_cap => 0)$$,
  'P0001', 'Trending per-author cap must be between 1 and 50', 'the trending author cap is bounded');
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_creator_prior_mean => 1.5)$$,
  'P0001', 'Creator prior mean must be between 0 and 1', 'the creator prior mean is a rate');
select throws_ok($$select * from public.get_ranked_feed_candidates_v3(p_cold_impression_threshold => -1)$$,
  'P0001', 'Cold-start impression threshold must be between 0 and 100000', 'the cold threshold is bounded');
reset role;

-- ─── Stats refreshes ─────────────────────────────────────────────────────────

set local role service_role;
select ok(public.refresh_creator_feed_stats(now(), 1000) >= 1, 'the creator refresh runs');
-- O, 30 days: two rendered deliveries, one "not interested"; distinct
-- non-dismissed (post, reporter) pairs on O's posts: (6, V) and (7, X).
select is((select negative_feedback_count from public.creator_feed_stats
  where creator_user_id = 'f3a00000-0000-4000-8000-000000000005' and window_key = '30d'),
  5::bigint, 'creator negatives are negative deliveries plus two per distinct report');
select ok((select abs(negative_feedback_rate - 5.2 / 22.0) < 1e-9 from public.creator_feed_stats
  where creator_user_id = 'f3a00000-0000-4000-8000-000000000005' and window_key = '30d'),
  'the creator negative rate is (negatives + 0.2) / (rendered + 20)');
select is((select rendered_count from public.creator_feed_stats
  where creator_user_id = 'f3a00000-0000-4000-8000-000000000005' and window_key = '30d'),
  2::bigint, 'existing creator columns are still filled');

select lives_ok($$select public.refresh_post_feed_stats(now(), 1000)$$, 'the post refresh runs');
select is((select impression_count from public.post_feed_stats
  where post_id = 'f3b00000-0000-4000-8000-000000000007' and window_key = '7d'),
  1::bigint, 'an impression whose session was pruned still counts in the 7-day window');
select is((select impression_count from public.post_feed_stats
  where post_id = 'f3b00000-0000-4000-8000-000000000007' and window_key = '24h'),
  0::bigint, 'the window still bounds what counts');
reset role;

-- ─── Activation ──────────────────────────────────────────────────────────────

set local role service_role;
select is(public.activate_feed_algorithm_version('f3c00000-0000-4000-8000-000000000002')->>'previous_active_id',
  'f3c00000-0000-4000-8000-000000000001', 'activation reports the version it retired');
select ok((select status = 'retired' and retired_at is not null from public.feed_algorithm_versions
  where id = 'f3c00000-0000-4000-8000-000000000001'), 'the previous active version is retired with a timestamp');
select ok((select status = 'active' and activated_at is not null from public.feed_algorithm_versions
  where id = 'f3c00000-0000-4000-8000-000000000002'), 'the shadow target is active');
select is((select count(*)::integer from public.feed_algorithm_versions
  where algorithm_key = 'v3-pgtap-fixture' and status = 'active'), 1, 'one key never has two active versions');
select throws_ok($$select public.activate_feed_algorithm_version('f3c00000-0000-4000-8000-000000000002')$$,
  'P0001', 'Feed algorithm version is already active', 'an active target is refused');
select throws_ok($$select public.activate_feed_algorithm_version('f3c00000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'Feed algorithm version does not exist', 'an unknown version is refused');
reset role;

-- Fail the second half of a swap: the retirement in the first half must roll
-- back with it, leaving the old version active and the target untouched.
create function public.v3_fail_activation() returns trigger language plpgsql as $$
begin
  if new.algorithm_key = 'v3-pgtap-fixture' and new.status = 'active' then
    raise exception 'Injected activation failure';
  end if;
  return new;
end;
$$;
create trigger v3_fail_activation before update on public.feed_algorithm_versions
for each row execute function public.v3_fail_activation();
set local role service_role;
select throws_ok($$select public.activate_feed_algorithm_version('f3c00000-0000-4000-8000-000000000003')$$,
  'P0001', 'Injected activation failure', 'a failure while activating aborts the whole swap');
select is((select status from public.feed_algorithm_versions where id = 'f3c00000-0000-4000-8000-000000000002'),
  'active', 'the failed swap leaves the active version active');
select is((select status from public.feed_algorithm_versions where id = 'f3c00000-0000-4000-8000-000000000003'),
  'draft', 'the failed swap leaves the target a draft');
reset role;
drop trigger v3_fail_activation on public.feed_algorithm_versions;
drop function public.v3_fail_activation();

-- Rollback is "activate the previous version": promote the seeded
-- for-you-rules v3, then activate the retired v1 again.
set local role service_role;
select is(public.activate_feed_algorithm_version(
    (select id from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 3)
  )->>'previous_active_id',
  (select id::text from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 1),
  'activating for-you-rules v3 retires v1');
select ok((select status = 'retired' and retired_at is not null from public.feed_algorithm_versions
  where algorithm_key = 'for-you-rules' and version = 1), 'v1 is retired with a timestamp');
select is(public.activate_feed_algorithm_version(
    (select id from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 1)
  )->>'previous_active_id',
  (select id::text from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 3),
  'a rollback activates the retired v1 and retires v3');
select ok((select status = 'active' and retired_at is null and activated_at is not null
  from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 1),
  'the rolled-back version is active again with retired_at cleared');
select is((select status from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 3),
  'retired', 'the version rolled back from is retired');
reset role;

-- ─── Experiments ─────────────────────────────────────────────────────────────

set local role service_role;
select throws_ok($$select public.create_feed_experiment(
  '{"experiment_key": "v3-pgtap-ab", "traffic_basis_points": 10000}',
  '[{"variant_key": "control", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000002", "allocation_basis_points": 5000},
    {"variant_key": "treatment", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000004", "allocation_basis_points": 4000}]'
)$$, 'P0001', 'Feed experiment variant allocations must sum to exactly 10000 basis points',
  'allocations summing below 10000 are rejected');
select throws_ok($$select public.create_feed_experiment(
  '{"experiment_key": "v3-pgtap-ab", "traffic_basis_points": 10000}',
  '[{"variant_key": "control", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000002", "allocation_basis_points": 5000},
    {"variant_key": "treatment", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000004", "allocation_basis_points": 6000}]'
)$$, 'P0001', 'Feed experiment variant allocations must sum to exactly 10000 basis points',
  'allocations summing above 10000 are rejected');
select throws_ok($$select public.create_feed_experiment(
  '{"experiment_key": "v3-pgtap-ab", "traffic_basis_points": 10000}',
  '[{"variant_key": "control", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000002", "allocation_basis_points": 5000},
    {"variant_key": "treatment", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000003", "allocation_basis_points": 5000}]'
)$$, 'P0001', 'Feed experiment variants must reference an active or shadow algorithm version',
  'a variant on a draft version is rejected');
select is((select count(*)::integer from public.feed_experiments where experiment_key = 'v3-pgtap-ab'),
  0, 'rejected experiments leave nothing behind');

select is(public.create_feed_experiment(
  '{"experiment_key": "v3-pgtap-ab", "traffic_basis_points": 10000}',
  '[{"variant_key": "control", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000002", "allocation_basis_points": 5000},
    {"variant_key": "treatment", "algorithm_version_id": "f3c00000-0000-4000-8000-000000000004", "allocation_basis_points": 5000}]'
)->>'experiment_key', 'v3-pgtap-ab', 'a 50/50 experiment over an active and a shadow version is created');
select ok((select status = 'running' and traffic_basis_points = 10000 and assignment_salt <> '' and starts_at is not null
    and ends_at is null
  from public.feed_experiments where experiment_key = 'v3-pgtap-ab'),
  'a new experiment defaults to running, salted, starting now and open-ended');
select is((select string_agg(v.variant_key || ':' || v.allocation_basis_points, ',' order by v.variant_key)
  from public.feed_experiment_variants as v
  join public.feed_experiments as e on e.id = v.experiment_id
  where e.experiment_key = 'v3-pgtap-ab'),
  'control:5000,treatment:5000', 'both variants are stored with their allocations');

select is(public.set_feed_experiment_status(
  (select id from public.feed_experiments where experiment_key = 'v3-pgtap-ab'), 'paused')->>'previous_status',
  'running', 'pausing reports the previous status');
select is((select status from public.feed_experiments where experiment_key = 'v3-pgtap-ab'),
  'paused', 'the experiment is paused');
select throws_ok($$select public.set_feed_experiment_status(
  (select id from public.feed_experiments where experiment_key = 'v3-pgtap-ab'), 'draft')$$,
  'P0001', 'Feed experiment status must be paused, completed, cancelled or running', 'only the four operator statuses are accepted');
reset role;

-- ─── Scorecard ───────────────────────────────────────────────────────────────

set local role service_role;
-- Facts 3 and 4: rendered, one negative, one 4 s dwell on a text post (a
-- meaningful engagement), both served after the viewer had already seen post 7.
select is((select served || '/' || rendered || '/' || qualified || '/' || meaningful || '/' || negatives
    || '/' || repeat_exposures || '/' || distinct_viewers || '/' || avg_position
  from public.feed_algorithm_scorecard(7)
  where algorithm_version_id = 'f3c00000-0000-4000-8000-000000000004' and candidate_source = 'trending'),
  '2/2/0/1/1/2/1/0.5', 'the scorecard counts outcomes per version and source');
select is((select served || '/' || rendered || '/' || algorithm_label from public.feed_algorithm_scorecard(7)
  where algorithm_version_id = 'f3c00000-0000-4000-8000-000000000004' and candidate_source = 'fresh'),
  '2/0/v3-pgtap-fixture-v4', 'served-but-unrendered deliveries count as served only, labelled key-vN');
-- The all-sources row: five deliveries, two of them rendered, to the viewer
-- and one signed-out key -- two viewers, however many sources reached them.
select is((select served || '/' || rendered || '/' || distinct_viewers from public.feed_algorithm_scorecard(7)
  where algorithm_version_id = 'f3c00000-0000-4000-8000-000000000004' and candidate_source is null),
  '5/2/2', 'one all-sources row per version counts each viewer once');
select throws_ok($$select * from public.feed_algorithm_scorecard(31)$$,
  'P0001', 'Feed scorecard days must be between 1 and 30', 'the scorecard window is bounded');
reset role;

select * from finish();
rollback;

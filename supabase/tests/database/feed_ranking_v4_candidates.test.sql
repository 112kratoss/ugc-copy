-- Feed ranking v4 (20261012061058_feed_ranking_v4_industry_parity.sql).
--
-- Content: embeddings are 384-dimensional, a post with no text of its own is
-- stored without a vector and read as no embedding, clusters and
-- near-duplicate marks are written through their RPCs, and the job's pending
-- list sees missing and stale embeddings, never-embedded first. Retrieval: a
-- taste vector from the viewer's positive deliveries yields a semantic pool
-- and a semantic_similarity feature; a near-duplicate or a labelled author
-- reaches only the author's followers, until the duplicate's canonical
-- leaves the feed. Signals: a server-written comment stamps commented_at and
-- counts as meaningful everywhere downstream, with or without a delivery,
-- interest weights gain a semantic_cluster dimension, and a succeeded
-- creation counts. Measurement: feed_viewer_daily keeps a row per viewer and
-- day without losing pruned visits, the new scorecards read it, retention
-- prunes it, and a draft version takes the next number. Every RPC is called
-- as service_role, the only role allowed to, so a missing table grant fails
-- here.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(107);

-- ─── Surface ─────────────────────────────────────────────────────────────────

create temporary table v4_functions as
select unnest(array[
  'public.get_ranked_feed_candidates_v4(uuid,text,text,integer,integer,integer,integer,integer,integer,double precision,double precision,timestamptz,integer,integer,integer,integer,integer,integer,double precision,integer,double precision,integer,integer,boolean,boolean)'::regprocedure,
  'public.match_post_content_embeddings(extensions.vector,text,double precision,integer)'::regprocedure,
  'public.is_meaningful_feed_engagement(text,double precision,bigint,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure,
  'public.record_showcase_feed_events(uuid,text,jsonb,boolean)'::regprocedure,
  'public.record_showcase_feed_events(uuid,text,jsonb)'::regprocedure,
  'public.refresh_post_feed_stats(timestamptz,integer)'::regprocedure,
  'public.refresh_post_feed_engagement_stats(timestamptz,integer)'::regprocedure,
  'public.refresh_creator_feed_stats(timestamptz,integer)'::regprocedure,
  'public.refresh_user_interest_weights(timestamptz,integer,integer,integer)'::regprocedure,
  'public.refresh_feed_delivery_fact_daily(timestamptz,integer,integer)'::regprocedure,
  'public.refresh_feed_viewer_daily(timestamptz,integer)'::regprocedure,
  'public.prune_feed_personalization_data(timestamptz,integer,integer,integer,integer,integer)'::regprocedure,
  'public.feed_scorecard_viewers(integer)'::regprocedure,
  'public.feed_scorecard_positions(integer)'::regprocedure,
  'public.feed_scorecard_formats(integer)'::regprocedure,
  'public.feed_experiment_assignment_counts(text)'::regprocedure,
  'public.create_feed_algorithm_version_draft(text,text,jsonb,jsonb,jsonb)'::regprocedure,
  'public.list_posts_pending_embedding(integer)'::regprocedure,
  'public.replace_feed_semantic_clusters(text,jsonb)'::regprocedure,
  'public.assign_post_semantic_clusters(jsonb)'::regprocedure,
  'public.mark_post_near_duplicates(jsonb)'::regprocedure,
  'public.clear_orphaned_near_duplicate_marks(integer)'::regprocedure,
  'public.get_ranked_feed_candidates(uuid,text,integer,timestamptz)'::regprocedure,
  'public.upsert_account_labels(jsonb)'::regprocedure,
  'public.delete_expired_account_labels(timestamptz)'::regprocedure
]) as fn;

select ok((select bool_and(has_function_privilege('service_role', fn, 'EXECUTE')) from v4_functions),
  'the service role can call every v4 function');
select ok((select bool_and(not has_function_privilege('anon', fn, 'EXECUTE')) from v4_functions),
  'anonymous clients cannot call any v4 function');
select ok((select bool_and(not has_function_privilege('authenticated', fn, 'EXECUTE')) from v4_functions),
  'signed-in clients cannot call any v4 function');
select ok((select bool_and(not p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'])
  from v4_functions join pg_proc as p on p.oid = v4_functions.fn),
  'every v4 function runs as its caller with a pinned search path');
select ok(
  to_regprocedure('public.is_meaningful_feed_engagement(text,double precision,bigint,timestamptz,timestamptz,timestamptz,timestamptz)') is null
    and to_regprocedure('public.prune_feed_personalization_data(timestamptz,integer,integer,integer,integer)') is null,
  'the replaced signatures are gone, so no call can be ambiguous');
select ok((select bool_and(c.relrowsecurity
    and not has_table_privilege('anon', c.oid, 'SELECT')
    and not has_table_privilege('authenticated', c.oid, 'SELECT')
    and has_table_privilege('service_role', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))
  from pg_class as c
  where c.oid in ('public.feed_semantic_clusters'::regclass, 'public.account_labels'::regclass,
    'public.feed_viewer_daily'::regclass)),
  'the three new tables are row-level secured and reachable by the service role only');
select is((select status || '/' || (retrieval_config->>'candidate_rpc') || '/' || (weights->>'semantic_similarity')
    || '/' || (weights->>'interest_match')
  from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 4),
  'shadow/v4/0.14/0.16', 'v4 is seeded as shadow with the semantic weight taken partly from interest_match');
select ok(to_regclass('public.post_content_embeddings_embedding_hnsw_idx') is not null,
  'embeddings carry an HNSW cosine index');
select ok(not exists(select 1 from pg_trigger
  where tgrelid = 'public.post_content_embeddings'::regclass and tgname = 'post_content_embeddings_set_updated_at'),
  'embedding rows no longer have their updated_at stamped by a trigger');

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- Users: viewer V(1), followed author of a near-duplicate F(2), other author
-- O(3), labelled author L(4) whom V follows, second viewer W(5), author with
-- an expired label X(6).

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
select ('f4a00000-0000-4000-8000-00000000000' || n)::uuid,
  'feed-v4-' || n || '@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now() - interval '60 days'
from generate_series(1, 6) as n;

-- Posts f4b…NN, all public text posts. A, B and C are ten days old (not cold).
-- N, never embedded, has not changed since the day it was posted; every other
-- post changed just now (C's edit is what makes it pending again).
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body, is_nsfw, created_at, updated_at)
values
  ('f4b00000-0000-4000-8000-000000000001', 'f4a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'A: what the viewer saved', false, now() - interval '10 days', now()),
  ('f4b00000-0000-4000-8000-000000000002', 'f4a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'B: close to A', false, now() - interval '10 days', now()),
  ('f4b00000-0000-4000-8000-000000000003', 'f4a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'C: unlike A, edited since its embedding', false, now() - interval '10 days', now()),
  ('f4b00000-0000-4000-8000-000000000004', 'f4a00000-0000-4000-8000-000000000002', 'public', 'text', 'external', 'text', 'visible', 'D: a near-duplicate of E', false, now() - interval '2 days', now()),
  ('f4b00000-0000-4000-8000-000000000005', 'f4a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'E: the canonical, older post', false, now() - interval '5 days', now()),
  ('f4b00000-0000-4000-8000-000000000006', 'f4a00000-0000-4000-8000-000000000004', 'public', 'text', 'external', 'text', 'visible', 'L1: by a labelled account', false, now() - interval '2 days', now()),
  ('f4b00000-0000-4000-8000-000000000007', 'f4a00000-0000-4000-8000-000000000006', 'public', 'text', 'external', 'text', 'visible', 'X1: by an account whose label expired', false, now() - interval '2 days', now()),
  ('f4b00000-0000-4000-8000-000000000008', 'f4a00000-0000-4000-8000-000000000003', 'public', 'text', 'external', 'text', 'visible', 'N: never embedded', false, now() - interval '1 day', now() - interval '1 day'),
  ('f4b00000-0000-4000-8000-000000000009', 'f4a00000-0000-4000-8000-000000000002', 'public', 'text', 'external', 'text', 'visible', 'U: checked as text-empty', false, now() - interval '3 days', now());

insert into public.follows (follower_id, following_id)
values
  ('f4a00000-0000-4000-8000-000000000001', 'f4a00000-0000-4000-8000-000000000002'),
  ('f4a00000-0000-4000-8000-000000000001', 'f4a00000-0000-4000-8000-000000000004');

-- Unit vectors in 384 dimensions: axis k, and B = 0.9 e1 + sqrt(0.19) e2.
create temporary table v4_vectors (name text primary key, vec real[] not null);
insert into v4_vectors
select axis.name, (
  select array_agg((case
    when i = axis.first_axis then axis.first_weight
    when i = axis.second_axis then axis.second_weight
    else 0
  end)::real order by i)
  from generate_series(1, 384) as i
)
from (values
  ('e1', 1, 1.0, 0, 0.0),
  ('b', 1, 0.9, 2, sqrt(0.19)),
  ('e3', 3, 1.0, 0, 0.0),
  ('e4', 4, 1.0, 0, 0.0),
  ('e5', 5, 1.0, 0, 0.0),
  ('e6', 6, 1.0, 0, 0.0)
) as axis(name, first_axis, first_weight, second_axis, second_weight);
insert into v4_vectors
select 'short', array[1, 0, 0]::real[]
union all
select 'wide', (select array_agg(0.01::real) from generate_series(1, 1536));
grant select on v4_vectors to service_role;

-- C's embedding predates its post's last edit, so it is pending again.
insert into public.post_content_embeddings (post_id, embedding_model, content_hash, embedding, embedded_at, updated_at)
select p.id, 'gte-small', repeat('a', 64), v.vec::extensions.vector(384), now() - interval '1 day',
  case when p.id = 'f4b00000-0000-4000-8000-000000000003' then p.updated_at - interval '1 day' else p.updated_at end
from public.posts as p
join (values
  ('f4b00000-0000-4000-8000-000000000001'::uuid, 'e1'),
  ('f4b00000-0000-4000-8000-000000000002'::uuid, 'b'),
  ('f4b00000-0000-4000-8000-000000000003'::uuid, 'e3'),
  ('f4b00000-0000-4000-8000-000000000004'::uuid, 'e4'),
  ('f4b00000-0000-4000-8000-000000000005'::uuid, 'e4'),
  ('f4b00000-0000-4000-8000-000000000006'::uuid, 'e5'),
  ('f4b00000-0000-4000-8000-000000000007'::uuid, 'e6')
) as fixture(post_id, vector_name) on fixture.post_id = p.id
join v4_vectors as v on v.name = fixture.vector_name;

-- U as embed-post leaves a post with no title, description, body or prompt:
-- text-empty, no vector, checked at its current version. Its cluster and its
-- mark (a duplicate of A) are left from an embedding of an earlier text.
insert into public.post_content_embeddings (
  post_id, embedding_model, content_hash, embedding, text_empty, cluster_id, canonical_post_id, embedded_at, updated_at
)
select p.id, 'gte-small', repeat('b', 64), null, true, 8, 'f4b00000-0000-4000-8000-000000000001',
  now() - interval '1 day', p.updated_at
from public.posts as p
where p.id = 'f4b00000-0000-4000-8000-000000000009';

-- D, E and L1 all trend.
insert into public.post_feed_stats (post_id, window_key, rendered_count, meaningful_engagement_count, meaningful_engagement_rate)
values
  ('f4b00000-0000-4000-8000-000000000004', '24h', 10, 5, 0.5),
  ('f4b00000-0000-4000-8000-000000000005', '24h', 10, 5, 0.5),
  ('f4b00000-0000-4000-8000-000000000006', '24h', 10, 5, 0.5);

-- V already weighs cluster 7 (B's) at 5.
insert into public.user_interest_weights (
  user_id, dimension_type, dimension_value, weight, positive_score, negative_score,
  positive_event_count, negative_event_count, last_event_at, last_event_received_at
)
values ('f4a00000-0000-4000-8000-000000000001', 'semantic_cluster', 'c7', 5.0, 5.0, 0, 1, 0, now(), now());

create temporary table v4_clock as
select
  (date_trunc('day', now() at time zone 'utc') - interval '12 hours') at time zone 'utc' as day1,
  (date_trunc('day', now() at time zone 'utc') - interval '36 hours') at time zone 'utc' as day2,
  (select id from public.feed_algorithm_versions where algorithm_key = 'for-you-rules' and version = 4) as version_id;
grant select on v4_clock to service_role;

-- A live session for V with one served delivery of C (the comment target).
insert into public.feed_sessions (id, viewer_user_id, algorithm_version_id, created_at, expires_at)
select 'f4d00000-0000-4000-8000-000000000002', 'f4a00000-0000-4000-8000-000000000001', version_id,
  now() - interval '10 minutes', now() + interval '110 minutes'
from v4_clock;
insert into public.feed_session_items (id, session_id, post_id, position, candidate_source, final_score, served_at)
overriding system value
values (9400000002, 'f4d00000-0000-4000-8000-000000000002', 'f4b00000-0000-4000-8000-000000000003', 1, 'fresh', 0.5, now() - interval '5 minutes');
-- W opened the feed today and was served nothing.
insert into public.feed_sessions (id, viewer_user_id, algorithm_version_id, created_at, expires_at)
select 'f4d00000-0000-4000-8000-000000000005', 'f4a00000-0000-4000-8000-000000000005', version_id,
  now() - interval '1 minute', now() + interval '119 minutes'
from v4_clock;

-- Facts. 1: V saved A yesterday (the taste). 2: V was served C yesterday in
-- the live session. 3: an anonymous viewer was shown E yesterday at slot 13.
-- 4: V was served X1 the day before.
insert into public.feed_delivery_facts (
  delivery_id, session_id, algorithm_version_id, viewer_user_id, anonymous_key_hash, post_id, creator_user_id,
  position, candidate_source, final_score, surface, mode, ranked_at, served_at, rendered_at, saved_at
)
select fact.delivery_id, fact.session_id, v4_clock.version_id, fact.viewer_user_id, fact.anonymous_key_hash,
  fact.post_id, fact.creator_user_id, fact.position, 'fresh', 0.5, 'feed', 'for-you',
  fact.served_at, fact.served_at, fact.rendered_at, fact.saved_at
from v4_clock
cross join lateral (values
  (9400000001::bigint, gen_random_uuid(), 'f4a00000-0000-4000-8000-000000000001'::uuid, null::text,
   'f4b00000-0000-4000-8000-000000000001'::uuid, 'f4a00000-0000-4000-8000-000000000003'::uuid, 0,
   v4_clock.day1, v4_clock.day1, v4_clock.day1),
  (9400000002::bigint, 'f4d00000-0000-4000-8000-000000000002'::uuid, 'f4a00000-0000-4000-8000-000000000001'::uuid, null::text,
   'f4b00000-0000-4000-8000-000000000003'::uuid, 'f4a00000-0000-4000-8000-000000000003'::uuid, 1,
   v4_clock.day1 + interval '1 minute', null::timestamptz, null::timestamptz),
  (9400000003::bigint, gen_random_uuid(), null::uuid, repeat('a', 64),
   'f4b00000-0000-4000-8000-000000000005'::uuid, 'f4a00000-0000-4000-8000-000000000003'::uuid, 12,
   v4_clock.day1, v4_clock.day1, null::timestamptz),
  (9400000004::bigint, gen_random_uuid(), 'f4a00000-0000-4000-8000-000000000001'::uuid, null::text,
   'f4b00000-0000-4000-8000-000000000007'::uuid, 'f4a00000-0000-4000-8000-000000000006'::uuid, 3,
   v4_clock.day2, null::timestamptz, null::timestamptz)
) as fact(delivery_id, session_id, viewer_user_id, anonymous_key_hash, post_id, creator_user_id, position,
  served_at, rendered_at, saved_at);

-- A creation by V an hour after V's first serve in the window, settled the
-- way the generation pipeline settles one (20260621235959).
insert into public.generations (user_id, status, category, prompt, created_at, completed_at)
select 'f4a00000-0000-4000-8000-000000000001', 'succeeded', 'image', 'feed v4 fixture',
  day2 + interval '1 hour', day2 + interval '2 hours'
from v4_clock;

insert into public.feed_algorithm_versions (algorithm_key, version, status)
values ('v4-pgtap-fixture', 1, 'shadow'), ('v4-pgtap-fixture', 2, 'draft');

-- 5: another anonymous viewer saved U yesterday, its only positive delivery,
-- under the fixture's own version so v4's rollups and scorecards see none of it.
insert into public.feed_delivery_facts (
  delivery_id, session_id, algorithm_version_id, viewer_user_id, anonymous_key_hash, post_id, creator_user_id,
  position, candidate_source, final_score, surface, mode, ranked_at, served_at, rendered_at, saved_at
)
select 9400000005, gen_random_uuid(), versions.id, null, repeat('d', 64),
  'f4b00000-0000-4000-8000-000000000009', 'f4a00000-0000-4000-8000-000000000002',
  0, 'fresh', 0.5, 'feed', 'for-you', v4_clock.day1, v4_clock.day1, v4_clock.day1, v4_clock.day1
from v4_clock
join public.feed_algorithm_versions as versions
  on versions.algorithm_key = 'v4-pgtap-fixture' and versions.version = 1;

-- ─── Embeddings ──────────────────────────────────────────────────────────────

select is((select embedding_dimensions from public.post_content_embeddings
  where post_id = 'f4b00000-0000-4000-8000-000000000001'), 384, 'embedding_dimensions defaults to 384');
select throws_ok($$insert into public.post_content_embeddings (post_id, embedding_model, embedding_dimensions, content_hash, embedding)
  select 'f4b00000-0000-4000-8000-000000000008', 'gte-small', 1536, repeat('a', 64), vec::extensions.vector(384)
  from v4_vectors where name = 'e1'$$,
  '23514', null, 'a row claiming 1536 dimensions is refused');
select throws_ok($$insert into public.post_content_embeddings (post_id, embedding_model, content_hash, embedding)
  select 'f4b00000-0000-4000-8000-000000000008', 'gte-small', repeat('a', 64), vec::extensions.vector
  from v4_vectors where name = 'wide'$$,
  '22000', null, 'a 1536-dimension vector does not fit the column');
select throws_ok($$insert into public.post_content_embeddings (post_id, embedding_model, content_hash, embedding)
  values ('f4b00000-0000-4000-8000-000000000008', 'gte-small', repeat('a', 64), null)$$,
  '23514', null, 'only a text-empty row may lack a vector');
select throws_ok($$insert into public.post_content_embeddings (post_id, embedding_model, content_hash, embedding, text_empty)
  select 'f4b00000-0000-4000-8000-000000000008', 'gte-small', repeat('a', 64), vec::extensions.vector(384), true
  from v4_vectors where name = 'e1'$$,
  '23514', null, 'a text-empty row has no vector');

set local role service_role;
select is((select post_id from public.match_post_content_embeddings(
    (select vec from v4_vectors where name = 'e1')::extensions.vector(384), 'gte-small', 0.5, 5) limit 1),
  'f4b00000-0000-4000-8000-000000000001'::uuid, 'the nearest post to e1 is A');
select ok((select abs(semantic_similarity - 0.9) < 1e-6 from public.match_post_content_embeddings(
    (select vec from v4_vectors where name = 'e1')::extensions.vector(384), 'gte-small', 0.5, 5)
  where post_id = 'f4b00000-0000-4000-8000-000000000002'),
  'match_post_content_embeddings reports cosine similarity');
select throws_ok($$select * from public.match_post_content_embeddings(
    (select vec from v4_vectors where name = 'short')::extensions.vector, 'gte-small', 0.0, 5)$$,
  'P0001', 'Semantic query embedding must have 384 dimensions', 'a query of another width is refused');

select is(public.replace_feed_semantic_clusters('gte-small', jsonb_build_array(
    jsonb_build_object('cluster_id', 7, 'member_count', 2, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'b')),
    jsonb_build_object('cluster_id', 8, 'member_count', 1, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'e3')),
    jsonb_build_object('cluster_id', 9, 'member_count', 0, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'e6'))
  )), 3, 'clusters are written from JSON centroids');
select is(public.replace_feed_semantic_clusters('gte-small', jsonb_build_array(
    jsonb_build_object('cluster_id', 7, 'member_count', 2, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'b')),
    jsonb_build_object('cluster_id', 8, 'member_count', 1, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'e3'))
  )), 2, 'a second run replaces the model''s clusters');
select is((select string_agg(cluster_id::text, ',' order by cluster_id) from public.feed_semantic_clusters
  where embedding_model = 'gte-small'), '7,8', 'only the latest clusters remain');
select throws_ok($$select public.replace_feed_semantic_clusters('gte-small',
    '[{"cluster_id": 1, "member_count": 1, "centroid": [1, 0, 0]}]')$$,
  'P0001', 'Semantic cluster centroids must be arrays of 384 numbers', 'a centroid of another width is refused');
select throws_ok($$select public.replace_feed_semantic_clusters('gte-small', jsonb_build_array(
    jsonb_build_object('cluster_id', 1, 'member_count', 1, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'e1')),
    jsonb_build_object('cluster_id', 1, 'member_count', 1, 'centroid', (select to_jsonb(vec) from v4_vectors where name = 'e1'))))$$,
  'P0001', 'Semantic cluster ids must be unique', 'duplicate cluster ids are refused');

select is(public.assign_post_semantic_clusters(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000002", "cluster_id": 7},
    {"post_id": "f4b00000-0000-4000-8000-000000000003", "cluster_id": 8},
    {"post_id": "f4b00000-0000-4000-8000-000000000008", "cluster_id": 8}]'), 2,
  'cluster assignments update the embedded posts and skip a post without an embedding');
select is(public.assign_post_semantic_clusters(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000002", "cluster_id": 7}]'), 0,
  'an unchanged assignment writes nothing');
select ok((select updated_at = (select updated_at from public.posts where id = 'f4b00000-0000-4000-8000-000000000002')
  from public.post_content_embeddings where post_id = 'f4b00000-0000-4000-8000-000000000002'),
  'a cluster assignment leaves updated_at, the embedded text''s version, alone');

select is(public.mark_post_near_duplicates(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000004", "canonical_post_id": "f4b00000-0000-4000-8000-000000000005", "similarity": 0.99}]'),
  1, 'the newer post is marked a near-duplicate of the older');
select throws_ok($$select public.mark_post_near_duplicates(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000003", "canonical_post_id": "f4b00000-0000-4000-8000-000000000003", "similarity": 1}]')$$,
  'P0001', 'A post cannot be a near-duplicate of itself', 'a self-reference is refused');
select throws_ok($$select public.mark_post_near_duplicates(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000005", "canonical_post_id": "f4b00000-0000-4000-8000-000000000003", "similarity": 0.97}]')$$,
  'P0001', 'A near-duplicate''s canonical post cannot itself be a near-duplicate',
  'a canonical post cannot become a duplicate itself');
select throws_ok($$select public.mark_post_near_duplicates(
  '[{"post_id": "f4b00000-0000-4000-8000-000000000003", "canonical_post_id": "f4b00000-0000-4000-8000-000000000004", "similarity": 0.96}]')$$,
  'P0001', 'A near-duplicate''s canonical post cannot itself be a near-duplicate',
  'a post cannot point at a near-duplicate');
select ok((select canonical_post_id is null from public.post_content_embeddings
  where post_id = 'f4b00000-0000-4000-8000-000000000005'), 'a refused call changes nothing');

select is((select array_agg(post_id order by post_id) from public.list_posts_pending_embedding(200)
  where post_id::text like 'f4b00000-%'),
  array['f4b00000-0000-4000-8000-000000000003', 'f4b00000-0000-4000-8000-000000000008']::uuid[],
  'the pending list holds the never-embedded post and the one edited since, not one checked as text-empty');
select is((select array_agg(pending.post_id order by pending.listed)
    from public.list_posts_pending_embedding(200) with ordinality as pending(post_id, updated_at, listed)
    where pending.post_id::text like 'f4b00000-%'),
  array['f4b00000-0000-4000-8000-000000000008', 'f4b00000-0000-4000-8000-000000000003']::uuid[],
  'a never-embedded post comes before one changed more recently');
select throws_ok($$select * from public.list_posts_pending_embedding(0)$$,
  'P0001', 'Pending embedding limit must be between 1 and 1000', 'the pending list is bounded');

select is(public.upsert_account_labels(jsonb_build_array(
  jsonb_build_object('user_id', 'f4a00000-0000-4000-8000-000000000004', 'label', 'spam_account',
    'source', 'pgtap', 'expires_at', now() + interval '7 days'),
  jsonb_build_object('user_id', 'f4a00000-0000-4000-8000-000000000006', 'label', 'nsfw_account',
    'source', 'pgtap', 'expires_at', now() - interval '1 day')
)), 2, 'account labels are upserted');
select throws_ok($$select public.upsert_account_labels(
  '[{"user_id": "f4a00000-0000-4000-8000-000000000004", "label": "toxic_account", "source": "pgtap", "expires_at": "2030-01-01T00:00:00Z"}]')$$,
  'P0001', 'Account label must be nsfw_account, negative_feedback_account or spam_account', 'unknown labels are refused');
reset role;

-- ─── Candidates ──────────────────────────────────────────────────────────────

create temporary table v4_signed_in as
select * from public.get_ranked_feed_candidates_v4() with no data;
create temporary table v4_other as
select * from public.get_ranked_feed_candidates_v4() with no data;
create temporary table v4_unfiltered as
select * from public.get_ranked_feed_candidates_v4() with no data;
create temporary table v4_strict as
select * from public.get_ranked_feed_candidates_v4() with no data;
create temporary table v4_anonymous as
select * from public.get_ranked_feed_candidates_v4() with no data;
grant select, insert on v4_signed_in, v4_other, v4_unfiltered, v4_strict, v4_anonymous to service_role;

set local role service_role;
insert into v4_signed_in
select * from public.get_ranked_feed_candidates_v4(
  p_viewer_user_id => 'f4a00000-0000-4000-8000-000000000001', p_as_of => now());
insert into v4_other
select * from public.get_ranked_feed_candidates_v4(
  p_viewer_user_id => 'f4a00000-0000-4000-8000-000000000005', p_as_of => now());
insert into v4_unfiltered
select * from public.get_ranked_feed_candidates_v4(
  p_viewer_user_id => 'f4a00000-0000-4000-8000-000000000005', p_as_of => now(),
  p_exclude_near_duplicates => false, p_exclude_labelled_accounts => false);
insert into v4_strict
select * from public.get_ranked_feed_candidates_v4(
  p_viewer_user_id => 'f4a00000-0000-4000-8000-000000000001', p_as_of => now(),
  p_semantic_min_similarity => 0.5);
insert into v4_anonymous
select * from public.get_ranked_feed_candidates_v4(p_anonymous_key_hash => repeat('a', 64), p_as_of => now());
reset role;

select ok((select bool_and(taste_available) from v4_signed_in),
  'a viewer with a saved delivery has a taste vector');
select ok((select sources @> '{semantic}' and candidate_source = 'semantic' and abs(semantic_similarity - 0.9) < 1e-6
  from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000002'),
  'the taste vector retrieves a close post through the semantic pool, with its similarity');
select ok((select abs(semantic_similarity - 1.0) < 1e-6
  from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000001'),
  'the saved post itself is at similarity 1');
select is((select semantic_similarity from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000003'),
  0.0::double precision, 'an orthogonal post scores 0');
select is((select semantic_similarity from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000008'),
  0.0::double precision, 'a post without an embedding scores 0');
select is((select semantic_cluster from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000002'),
  'c7', 'semantic_cluster names the post''s cluster');
select ok((select semantic_cluster is null from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000001'),
  'an unclustered post has no semantic_cluster');
select is((select interest_match from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000002'),
  0.5::double precision, 'interest_match reads the viewer''s semantic_cluster weight');
select ok((select sources @> '{semantic}' from v4_strict where post_id = 'f4b00000-0000-4000-8000-000000000002')
  and (select not (sources @> '{semantic}') from v4_strict where post_id = 'f4b00000-0000-4000-8000-000000000003'),
  'semantic_min_similarity keeps distant posts out of the semantic pool');

select is((select sources from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000004'),
  '{following}'::text[], 'a followed author''s near-duplicate arrives through following only, not trending');
select ok(not exists(select 1 from v4_other where post_id = 'f4b00000-0000-4000-8000-000000000004'),
  'a near-duplicate never reaches a viewer who does not follow its author');
select ok((select sources @> '{trending}' from v4_other where post_id = 'f4b00000-0000-4000-8000-000000000005'),
  'its canonical post still trends');
select is((select sources from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000006'),
  '{following}'::text[], 'a labelled account reaches its followers through following only');
select ok(not exists(select 1 from v4_other where post_id = 'f4b00000-0000-4000-8000-000000000006'),
  'a labelled account is excluded from every out-of-network pool');
select ok(exists(select 1 from v4_other where post_id = 'f4b00000-0000-4000-8000-000000000007'),
  'an expired label excludes nothing');
select ok(exists(select 1 from v4_unfiltered where post_id = 'f4b00000-0000-4000-8000-000000000004')
  and exists(select 1 from v4_unfiltered where post_id = 'f4b00000-0000-4000-8000-000000000006'),
  'both exclusions can be switched off');
select ok((select bool_and(not taste_available and semantic_similarity = 0) from v4_other),
  'a viewer with no positive delivery has no taste and no similarity');
select ok(not exists(select 1 from v4_other where sources @> '{semantic}'),
  'without a taste vector there is no semantic pool');
select ok((select bool_and(not taste_available) from v4_anonymous)
  and not exists(select 1 from v4_anonymous where post_id = 'f4b00000-0000-4000-8000-000000000004'),
  'signed out: a delivery without a positive outcome is no taste, and near-duplicates stay out');
select ok((select bool_and(candidate_source = sources[1]) from v4_signed_in),
  'candidate_source is always the highest-priority source');
select ok((select semantic_cluster is null from v4_signed_in where post_id = 'f4b00000-0000-4000-8000-000000000009')
    and exists(select 1 from v4_other where post_id = 'f4b00000-0000-4000-8000-000000000009'),
  'a text-empty row is no embedding: the cluster and near-duplicate mark left from an earlier one are ignored');

set local role service_role;
select throws_ok($$select * from public.get_ranked_feed_candidates_v4(p_semantic_limit => 501)$$,
  'P0001', 'Feed candidate pool limits must be between 0 and 500', 'the semantic pool limit is bounded');
select throws_ok($$select * from public.get_ranked_feed_candidates_v4(p_semantic_min_similarity => 1.5)$$,
  'P0001', 'Semantic minimum similarity must be between -1 and 1', 'the semantic floor is a cosine');
select throws_ok($$select * from public.get_ranked_feed_candidates_v4(p_taste_lookback_days => 0)$$,
  'P0001', 'Taste lookback days must be between 1 and 365', 'the taste lookback is bounded');
select throws_ok($$select * from public.get_ranked_feed_candidates_v4(p_taste_limit => 201)$$,
  'P0001', 'Taste limit must be between 1 and 200', 'the taste sample is bounded');
select ok((select bool_and(not taste_available) from public.get_ranked_feed_candidates_v4(
    p_anonymous_key_hash => repeat('d', 64), p_as_of => now())),
  'a saved post without a vector gives no taste');
reset role;

-- ─── A near-duplicate whose canonical left the feed ──────────────────────────

create temporary table v4_canonical_gone as
select * from public.get_ranked_feed_candidates_v4() with no data;
grant select, insert on v4_canonical_gone to service_role;

update public.posts set archived_at = now() where id = 'f4b00000-0000-4000-8000-000000000005';
set local role service_role;
insert into v4_canonical_gone
select * from public.get_ranked_feed_candidates_v4(
  p_viewer_user_id => 'f4a00000-0000-4000-8000-000000000005', p_as_of => now());
reset role;
select ok(exists(select 1 from v4_canonical_gone where post_id = 'f4b00000-0000-4000-8000-000000000004'),
  'once its canonical is archived, a near-duplicate reaches viewers who do not follow its author again');

set local role service_role;
select is(public.clear_orphaned_near_duplicate_marks(1000), 1,
  'the job''s pass clears the one mark whose canonical left the feed');
select throws_ok($$select public.clear_orphaned_near_duplicate_marks(0)$$,
  'P0001', 'Orphaned near-duplicate limit must be between 1 and 10000', 'the pass is bounded');
reset role;
select ok((select canonical_post_id is null and near_duplicate_similarity is null
    from public.post_content_embeddings where post_id = 'f4b00000-0000-4000-8000-000000000004')
  and (select canonical_post_id = 'f4b00000-0000-4000-8000-000000000001'
    from public.post_content_embeddings where post_id = 'f4b00000-0000-4000-8000-000000000009'),
  'the duplicate is released, and a mark whose canonical is still in the feed stays');
update public.posts set archived_at = null where id = 'f4b00000-0000-4000-8000-000000000005';

-- ─── The comment event ───────────────────────────────────────────────────────

select ok(public.is_meaningful_feed_engagement('text', 0, 0, null, null, null, null, now())
  and not public.is_meaningful_feed_engagement('text', 0, 0, null, null, null, null),
  'a comment is a meaningful engagement, and seven-argument callers keep their meaning');

create temporary table v4_comment_result (summary jsonb);
create temporary table v4_viewer_refresh (written integer);
create temporary table v4_prune (summary jsonb);
grant select, insert on v4_comment_result, v4_viewer_refresh, v4_prune to service_role;

set local role service_role;
insert into v4_comment_result
select public.record_showcase_feed_events(
  'f4a00000-0000-4000-8000-000000000001', null,
  jsonb_build_array(jsonb_build_object(
    'clientEventId', 'feed-v4-comment',
    'feedSessionId', 'f4d00000-0000-4000-8000-000000000002',
    'deliveryId', '9400000002',
    'postId', 'f4b00000-0000-4000-8000-000000000003',
    'eventType', 'comment',
    'sourceSurface', 'feed',
    'occurredAt', now()
  )),
  true
);
reset role;

select is((select summary->>'recorded' from v4_comment_result), '1',
  'a server action records a comment against its delivery');
select ok((select commented_at is not null and rendered_at is not null from public.feed_delivery_facts
  where delivery_id = 9400000002), 'the comment stamps commented_at on the delivery fact');

set local role service_role;
select is((public.record_showcase_feed_events(
  'f4a00000-0000-4000-8000-000000000001', null,
  jsonb_build_array(jsonb_build_object(
    'clientEventId', 'feed-v4-client-comment', 'postId', 'f4b00000-0000-4000-8000-000000000003',
    'eventType', 'comment', 'sourceSurface', 'feed', 'occurredAt', now()))
)->'outcomes'->0->>'status'), '400', 'a client batch cannot record a comment');
select is((public.record_showcase_feed_events(
  'f4a00000-0000-4000-8000-000000000001', null,
  jsonb_build_array(jsonb_build_object(
    'clientEventId', 'feed-v4-server-report', 'postId', 'f4b00000-0000-4000-8000-000000000003',
    'eventType', 'report', 'sourceSurface', 'feed', 'occurredAt', now())),
  true
)->'outcomes'->0->>'status'), '400', 'not even a server action records a report feed event');
select is((public.record_showcase_feed_events(
  null, repeat('b', 64),
  jsonb_build_array(jsonb_build_object(
    'clientEventId', 'feed-v4-anonymous-comment', 'postId', 'f4b00000-0000-4000-8000-000000000003',
    'eventType', 'comment', 'sourceSurface', 'feed', 'occurredAt', now())),
  true
)->'outcomes'->0->>'status'), '401', 'a server-written comment needs a signed-in viewer');
-- W comments on B from outside the feed: no delivery to name.
select is((public.record_showcase_feed_events(
  'f4a00000-0000-4000-8000-000000000005', null,
  jsonb_build_array(jsonb_build_object(
    'clientEventId', 'feed-v4-undelivered-comment', 'postId', 'f4b00000-0000-4000-8000-000000000002',
    'eventType', 'comment', 'sourceSurface', 'feed', 'occurredAt', now())),
  true
)->>'recorded'), '1', 'a server action records a comment that has no delivery');
select throws_ok($$select public.record_showcase_feed_events(
  'f4a00000-0000-4000-8000-000000000001', null,
  '[{"clientEventId": "x", "postId": "f4b00000-0000-4000-8000-000000000003", "eventType": "open"}]', null)$$,
  'P0001', 'Feed event batch authority must be true or false', 'the authority flag is required');
reset role;

-- ─── Stats refreshes ─────────────────────────────────────────────────────────

set local role service_role;
select lives_ok($$select public.refresh_post_feed_stats(now(), 1000)$$, 'the post refresh runs');
select ok((select comment_count = 1 and abs(usefulness_score - 3.0 / 25.0) < 1e-9 from public.post_feed_stats
  where post_id = 'f4b00000-0000-4000-8000-000000000003' and window_key = '7d'),
  'comments are counted and weigh 1.0 in usefulness');
select is((select comment_count from public.post_feed_stats
    where post_id = 'f4b00000-0000-4000-8000-000000000002' and window_key = '7d'),
  1::bigint, 'a server-written comment counts without a delivery');
select lives_ok($$select public.refresh_post_feed_engagement_stats(now(), 1000)$$, 'the engagement refresh runs');
select is((select meaningful_engagement_count from public.post_feed_stats
  where post_id = 'f4b00000-0000-4000-8000-000000000003' and window_key = '7d'),
  1::bigint, 'a delivery answered only with a comment is meaningful');
select ok(public.refresh_creator_feed_stats(now(), 1000) >= 1, 'the creator refresh runs');
select is((select meaningful_engagement_count || '/' || rendered_count from public.creator_feed_stats
  where creator_user_id = 'f4a00000-0000-4000-8000-000000000003' and window_key = '30d'),
  '2/3', 'creator quality counts the commented delivery as meaningful');
select ok(public.refresh_user_interest_weights(now(), 90, 30, 1000) >= 1, 'the interest refresh runs');
select ok((select weight between 2.99 and 3.0 from public.user_interest_weights
  where user_id = 'f4a00000-0000-4000-8000-000000000001'
    and dimension_type = 'semantic_cluster' and dimension_value = 'c8'),
  'a comment weighs 3.0 and also writes the post''s semantic cluster');
select ok((select weight between 2.99 and 3.0 from public.user_interest_weights
  where user_id = 'f4a00000-0000-4000-8000-000000000001'
    and dimension_type = 'category' and dimension_value = 'text'),
  'the comment still writes the category, with the same weight');
select ok((select weight between 2.8 and 3.0 from public.user_interest_weights
  where user_id = 'f4a00000-0000-4000-8000-000000000001'
    and dimension_type = 'category' and dimension_value = 'image'),
  'a succeeded creation seeds its category');
select ok(public.refresh_feed_delivery_fact_daily(now(), 3, 400) is not null, 'the fact rollup runs');
select is((select comment_count || '/' || deliveries from public.feed_delivery_fact_daily
  where algorithm_version_id = (select version_id from v4_clock)
    and fact_date = (select day1 from v4_clock)::date and candidate_source = 'fresh'
    and experiment_variant_id is null),
  '1/3', 'the daily fact rollup counts comments');
reset role;

-- ─── Viewer-grain rollup and scorecards ──────────────────────────────────────

set local role service_role;
insert into v4_viewer_refresh select public.refresh_feed_viewer_daily(now(), 3);
select ok((select written >= 4 from v4_viewer_refresh), 'the viewer rollup writes a row per viewer and day');
select is(public.refresh_feed_viewer_daily(now(), 3), (select written from v4_viewer_refresh),
  'running it again rewrites the same rows instead of adding more');
select is((select string_agg(viewer_key || ':' || (fact_date - (select day1 from v4_clock)::date)
      || ':' || sessions || '/' || served || '/' || rendered || '/' || meaningful || '/' || saves || '/' || comments,
      ',' order by viewer_key, fact_date)
    from public.feed_viewer_daily
    where viewer_key in ('f4a00000-0000-4000-8000-000000000001', 'f4a00000-0000-4000-8000-000000000005',
      'anon:' || repeat('a', 64))),
  'anon:' || repeat('a', 64) || ':0:1/1/1/0/0/0,'
    || 'f4a00000-0000-4000-8000-000000000001:-1:1/1/0/0/0/0,'
    || 'f4a00000-0000-4000-8000-000000000001:0:2/2/2/2/1/1,'
    || 'f4a00000-0000-4000-8000-000000000005:1:1/0/0/0/0/0',
  'sessions, serves and outcomes per viewer and day, a fact-less session counting as a visit');
select ok((select viewer_user_id is null and experiment_variant_id is null from public.feed_viewer_daily
  where viewer_key = 'anon:' || repeat('a', 64)), 'a signed-out viewer is keyed by its hash');

-- Stand-in for a fact-less visit counted on V's day before its session was
-- pruned (about two days after it expires): the next refresh cannot see it.
reset role;
update public.feed_viewer_daily set sessions = sessions + 1
where viewer_key = 'f4a00000-0000-4000-8000-000000000001'
  and fact_date = (select day1 from v4_clock)::date
  and algorithm_version_id = (select version_id from v4_clock);
set local role service_role;
do $$ begin perform public.refresh_feed_viewer_daily(now(), 3); end $$;
select is((select sessions from public.feed_viewer_daily
    where viewer_key = 'f4a00000-0000-4000-8000-000000000001'
      and fact_date = (select day1 from v4_clock)::date
      and algorithm_version_id = (select version_id from v4_clock)),
  3, 'a refresh never lowers a day''s session count');
reset role;
update public.feed_viewer_daily set sessions = sessions - 1
where viewer_key = 'f4a00000-0000-4000-8000-000000000001'
  and fact_date = (select day1 from v4_clock)::date
  and algorithm_version_id = (select version_id from v4_clock);
set local role service_role;

select is((select viewers || '/' || sessions || '/' || d1_eligible_viewers || '/' || d1_returned_viewers
    || '/' || d1_return_rate || '/' || signed_in_viewers || '/' || meaningful_creators_7d
    || '/' || meaningful_creation_7d_rate || '/' || coalesce(d7_return_rate::text, 'null')
  from public.feed_scorecard_viewers(7) where algorithm_version_id = (select version_id from v4_clock)),
  '2/4/1/1/1/1/1/1/null',
  'viewers, sessions, next-day return and the 7-day creation rate per version');
select is((select served || '/' || rendered from public.feed_scorecard_positions(7)
  where algorithm_version_id = (select version_id from v4_clock) and position_bucket = '1-3'),
  '2/2', 'positions are bucketed by one-based slot');
select is((select served from public.feed_scorecard_positions(7)
  where algorithm_version_id = (select version_id from v4_clock) and position_bucket = '13+'),
  1::bigint, 'slot 13 lands in the last bucket');
select is((select rendered || '/' || meaningful || '/' || quick_skips || '/' || video_half_completions
  from public.feed_scorecard_formats(7)
  where algorithm_version_id = (select version_id from v4_clock) and category = 'text'),
  '3/2/0/0', 'outcomes are split by format');
select throws_ok($$select * from public.feed_experiment_assignment_counts('v4-pgtap-missing')$$,
  'P0001', 'Feed experiment does not exist', 'assignment counts need a real experiment');
select throws_ok($$select * from public.feed_scorecard_viewers(91)$$,
  'P0001', 'Feed viewer scorecard days must be between 1 and 90', 'the viewer scorecard window is bounded');
select lives_ok($$select * from public.feed_algorithm_scorecard(7)$$,
  'the v3 scorecard still runs through the defaulted comment argument');
reset role;

-- ─── Retention ───────────────────────────────────────────────────────────────

insert into public.feed_viewer_daily (fact_date, viewer_key, viewer_user_id, algorithm_version_id, sessions, served)
select current_date - 500, 'f4a00000-0000-4000-8000-000000000001', 'f4a00000-0000-4000-8000-000000000001', version_id, 1, 1
from v4_clock;

set local role service_role;
insert into v4_prune select public.prune_feed_personalization_data(now(), 30, 2, 5000, 30, 400);
select is((select (summary->>'viewer_daily_deleted') || '/' || (summary->>'viewer_daily_retention_days_applied')
    || '/' || (summary->>'viewer_daily_retention_clamped') from v4_prune),
  '1/400/false', 'viewer rows past 400 days are pruned');
select is((select count(*)::integer from public.feed_viewer_daily
  where viewer_key = 'f4a00000-0000-4000-8000-000000000001'), 2, 'recent viewer rows are kept');
select is((public.prune_feed_personalization_data(now(), 30, 2, 5000, 30, 10)
    ->> 'viewer_daily_retention_days_applied'), '30',
  'a viewer retention shorter than the facts is clamped up to it');
select throws_ok($$select public.prune_feed_personalization_data(now(), 30, 2, 5000, 30, 0)$$,
  'P0001', 'Feed viewer daily retention days must be between 1 and 1460', 'invalid viewer retention still raises');
select is(public.delete_expired_account_labels(now()), 1, 'expired account labels are deleted');
reset role;

-- ─── Drafts ──────────────────────────────────────────────────────────────────

set local role service_role;
select is((public.create_feed_algorithm_version_draft('v4-pgtap-fixture', 'fitted',
    '{"interest_match": 0.2}', '{"candidate_rpc": "v4"}', '{}') ->> 'version'),
  '3', 'a draft takes the key''s next version');
select is((public.create_feed_algorithm_version_draft('v4-pgtap-fixture', null, '{}', '{}', '{}') ->> 'version'),
  '4', 'drafts keep counting');
select is((select status || '/' || (weights->>'interest_match') || '/' || (retrieval_config->>'candidate_rpc')
  from public.feed_algorithm_versions where algorithm_key = 'v4-pgtap-fixture' and version = 3),
  'draft/0.2/v4', 'the draft stores its configuration and serves nothing');
select throws_ok($$select public.create_feed_algorithm_version_draft('v4-pgtap-fixture', '', '[]', '{}', '{}')$$,
  'P0001', 'Feed algorithm weights must be a JSON object', 'weights must be an object');
reset role;

select * from finish();
rollback;

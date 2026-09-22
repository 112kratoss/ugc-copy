begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select ok(has_function_privilege('service_role', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE'), 'service role can persist');
select ok(not has_function_privilege('anon', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE'), 'anonymous clients cannot persist');
select ok(not has_function_privilege('authenticated', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE'), 'signed-in clients cannot bypass the API');
select ok(not (select prosecdef from pg_proc where oid = 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)'::regprocedure), 'function does not elevate caller privileges');

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('85100000-0000-4000-8000-000000000001', 'atomic-feed@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now());
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body)
select ('85200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '85100000-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'visible', 'atomic fixture'
from generate_series(1,3) n;

create temporary table atomic_ctx as
select jsonb_build_object(
  'viewer_user_id', '85100000-0000-4000-8000-000000000001', 'anonymous_key_hash', null,
  'filters', jsonb_build_object('category', 'all'), 'algorithm_version_id', id,
  'random_seed', 123, 'expires_at', now() + interval '2 hours', 'served_at', now()
) as session,
(select jsonb_agg(jsonb_build_object(
  'post_id', '85200000-0000-4000-8000-' || lpad(n::text,12,'0'),
  'creator_user_id', '85100000-0000-4000-8000-000000000001',
  'candidate_source', case when n = 2 then 'exploration' else 'recent' end,
  'final_score', 0.5, 'score_components', jsonb_build_object('freshness',0.5)
) order by n) from generate_series(1,3) n) as items
from public.feed_algorithm_versions order by created_at limit 1;

create temporary table atomic_result as
select public.persist_ranked_feed_session(session, items, '{}', 1, 1) as result from atomic_ctx;
select is(jsonb_array_length((select result->'deliveries' from atomic_result)), 3, 'all ranked candidates receive delivery IDs');
select is((select jsonb_agg((e->>'position')::integer order by (e->>'position')::integer) from atomic_result, jsonb_array_elements(result->'deliveries') e), '[0,1,2]'::jsonb, 'delivery positions preserve ranking');
select is((select count(*) from public.feed_session_items where session_id = (select (result->>'session_id')::uuid from atomic_result)), 3::bigint, 'all candidates remain pageable');
select is((select array_agg(position order by position) from public.feed_session_items where session_id = (select (result->>'session_id')::uuid from atomic_result) and served_at is not null), array[1], 'only requested positions are served');
select is((select count(*) from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_result)), 1::bigint, 'one served item creates exactly one fact');
select ok((select position = 1 and is_exploration and exploration_propensity = 1 and served_at = ranked_at and viewer_user_id = '85100000-0000-4000-8000-000000000001' and creator_user_id = viewer_user_id and score_components = '{"freshness":0.5}'::jsonb from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_result)), 'fact preserves identity, score, propensity and serve time');
select is((select (result->'deliveries'->1->>'id')::bigint from atomic_result), (select delivery_id from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_result)), 'returned ID is the ID recorded in the fact');

-- Anonymous identity is persisted without inventing a user or experiment.
create temporary table atomic_anon as select public.persist_ranked_feed_session(
  session || jsonb_build_object('viewer_user_id',null,'anonymous_key_hash',repeat('a',64)), items, '{}', 0, 2
) as result from atomic_ctx;
select is((select count(*) from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_anon) and viewer_user_id is null and anonymous_key_hash = repeat('a',64) and experiment_assignment_id is null), 2::bigint, 'anonymous scope and served slice are retained');
select ok((select bool_and(exploration_propensity = case when is_exploration then 1 else 0 end) from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_anon)), 'deterministic propensities remain 0 or 1');

insert into public.feed_experiments (id, experiment_key) values ('85300000-0000-4000-8000-000000000001','atomic-fixture');
insert into public.feed_experiment_variants (id, experiment_id, variant_key, algorithm_version_id, allocation_basis_points)
select '85400000-0000-4000-8000-000000000001','85300000-0000-4000-8000-000000000001','treatment',(session->>'algorithm_version_id')::uuid,10000 from atomic_ctx;
insert into public.feed_experiment_assignments (experiment_id, variant_id, viewer_user_id)
values ('85300000-0000-4000-8000-000000000001','85400000-0000-4000-8000-000000000001','85100000-0000-4000-8000-000000000001');
create temporary table atomic_experiment as
select public.persist_ranked_feed_session(session, items, jsonb_build_object(
  'assignment_id', a.id, 'experiment_id', a.experiment_id, 'variant_id', a.variant_id
), 0, 3) as result from atomic_ctx, public.feed_experiment_assignments a where a.experiment_id = '85300000-0000-4000-8000-000000000001';
select is((select count(*) from public.feed_delivery_facts where session_id = (select (result->>'session_id')::uuid from atomic_experiment) and experiment_assignment_id = (select id from public.feed_experiment_assignments where experiment_id = '85300000-0000-4000-8000-000000000001') and experiment_id = '85300000-0000-4000-8000-000000000001' and experiment_variant_id = '85400000-0000-4000-8000-000000000001'), 3::bigint, 'all experiment dimensions are copied to served facts');

create temporary table atomic_before as select
  (select count(*) from public.feed_sessions) as sessions,
  (select count(*) from public.feed_session_items) as items,
  (select count(*) from public.feed_delivery_facts) as facts;
select throws_ok($$select public.persist_ranked_feed_session(session, items || jsonb_build_array(items->0), '{}', 0, 1) from atomic_ctx$$, '23505', null, 'duplicate candidate aborts the transaction');
select throws_ok($$select public.persist_ranked_feed_session(session, items, '{"experiment_id":"85300000-0000-4000-8000-000000000001"}', 0, 1) from atomic_ctx$$, '23514', null, 'failure in final fact insertion aborts the whole call');
select is((select count(*) from public.feed_sessions), (select sessions from atomic_before), 'failed calls leave no orphan sessions');
select is((select count(*) from public.feed_session_items), (select items from atomic_before), 'failed calls leave no orphan items');
select is((select count(*) from public.feed_delivery_facts), (select facts from atomic_before), 'failed calls leave no partial exposures');
select throws_ok($$select public.persist_ranked_feed_session(session, '[]','{}',0,1) from atomic_ctx$$, '22023', null, 'empty candidate batches are rejected');
select throws_ok($$select public.persist_ranked_feed_session(session, (select jsonb_agg(items->0 order by n) from generate_series(1,61) n), '{}',0,1) from atomic_ctx$$, '22023', null, 'candidate batches are bounded at 60');
select throws_ok($$select public.persist_ranked_feed_session(session, items,'{}',-1,1) from atomic_ctx$$, '22023', null, 'negative offsets are rejected');
select throws_ok($$select public.persist_ranked_feed_session(session, items,'{}',0,0) from atomic_ctx$$, '22023', null, 'empty served-page limits are rejected');
select * from finish();
rollback;

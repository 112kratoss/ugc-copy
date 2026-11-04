-- persist_ranked_feed_session (20261104141149): a served delivery's score
-- components are stored once, on its fact; its session item keeps only the
-- keys serving reads again. An unserved item keeps the whole object, which a
-- continuation page copies into the fact it mints.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select ok(
  not (select prosecdef from pg_proc where oid = 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)'::regprocedure),
  'the function still runs with its caller''s privileges'
);
select ok(
  has_function_privilege('service_role', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.persist_ranked_feed_session(jsonb,jsonb,jsonb,integer,integer)', 'EXECUTE'),
  'and only the service role may call it'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('85300000-0000-4000-8000-000000000001', 'served-components@example.invalid', 'authenticated', 'authenticated', '{}', '{}', now());
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, review_status, body)
select ('85400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '85300000-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'visible', 'served components fixture'
from generate_series(1, 4) n;

-- Four candidates with the components the ranking writes; the second and third
-- are served (offset 1, limit 2). The third has no risk or follow keys.
create temporary table served_ctx on commit drop as
select jsonb_build_object(
  'viewer_user_id', '85300000-0000-4000-8000-000000000001', 'anonymous_key_hash', null,
  'filters', jsonb_build_object('category', 'all'), 'algorithm_version_id', id,
  'random_seed', 7, 'expires_at', now() + interval '2 hours', 'served_at', now()
) as session,
(select jsonb_agg(jsonb_build_object(
  'post_id', '85400000-0000-4000-8000-' || lpad(n::text, 12, '0'),
  'creator_user_id', '85300000-0000-4000-8000-000000000001',
  'candidate_source', 'recent',
  'final_score', 1.0 / n,
  'score_components', case when n = 3
    then jsonb_build_object('freshness', 0.25, 'interest_match', 0.5)
    else jsonb_build_object(
      'freshness', 0.5, 'interest_match', 0.1 * n, 'negative_feedback_risk', 0.03 * n,
      'is_following', n = 2, 'sources', jsonb_build_array('recent'),
      'ranking', jsonb_build_object('base', 0.4, 'offset', 0.001)
    ) end
) order by n) from generate_series(1, 4) n) as items
from public.feed_algorithm_versions order by created_at limit 1;

create temporary table served_result on commit drop as
select public.persist_ranked_feed_session(session, items, '{}', 1, 2) as result from served_ctx;

create temporary table served_session on commit drop as
select (result->>'session_id')::uuid as id from served_result;

select is(
  (select score_components from public.feed_delivery_facts
   where session_id = (select id from served_session) and position = 1),
  (select items->1->'score_components' from served_ctx),
  'a served delivery''s fact holds the whole object, ranking explanation included'
);
select is(
  (select score_components from public.feed_delivery_facts
   where session_id = (select id from served_session) and position = 2),
  (select items->2->'score_components' from served_ctx),
  'every served fact holds its own whole object'
);
select is(
  (select score_components from public.feed_session_items
   where session_id = (select id from served_session) and position = 1),
  '{"negative_feedback_risk": 0.06, "is_following": true}'::jsonb,
  'a served item keeps only the keys the visibility stage reads again'
);
select is(
  (select score_components from public.feed_session_items
   where session_id = (select id from served_session) and position = 2),
  '{}'::jsonb,
  'a served item whose ranking wrote neither key keeps an empty object'
);
select is(
  (select array_agg(score_components order by position) from public.feed_session_items
   where session_id = (select id from served_session) and served_at is null),
  (select array[items->0->'score_components', items->3->'score_components'] from served_ctx),
  'an unserved item keeps the whole object a continuation page will copy into its fact'
);
select is(
  (select count(*) from public.feed_delivery_facts where session_id = (select id from served_session)),
  2::bigint,
  'only the served slice has facts'
);

select * from finish();
rollback;

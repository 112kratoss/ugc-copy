begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

select is(
  (
    select count(*) = 3 and bool_and(procedures.prosecdef)
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.delete_feed_events_before_auth_user_delete()'::regprocedure,
      'public.delete_feed_events_before_post_delete()'::regprocedure,
      'public.detach_feed_events_before_session_delete()'::regprocedure
    ])
  ),
  true,
  'all feed parent-delete triggers run with their owner privileges'
);

select is(
  (
    select count(*) = 3
      and bool_and(pg_catalog.pg_get_userbyid(procedures.proowner) = 'postgres')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.delete_feed_events_before_auth_user_delete()'::regprocedure,
      'public.delete_feed_events_before_post_delete()'::regprocedure,
      'public.detach_feed_events_before_session_delete()'::regprocedure
    ])
  ),
  true,
  'all feed parent-delete triggers have the expected trusted owner'
);

select is(
  (
    select coalesce(bool_or(
      pg_catalog.has_function_privilege('anon', procedures.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('service_role', procedures.oid, 'EXECUTE')
    ), false)
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.delete_feed_events_before_auth_user_delete()'::regprocedure,
      'public.delete_feed_events_before_post_delete()'::regprocedure,
      'public.detach_feed_events_before_session_delete()'::regprocedure
    ])
  ),
  false,
  'application roles cannot invoke the privileged trigger functions directly'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  (
    '00000001-0000-4000-8000-000000000001'::uuid,
    'feed-prune-creator@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '00000002-0000-4000-8000-000000000002'::uuid,
    'feed-prune-viewer@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into public.posts (id, user_id, category, source_kind, post_format, body)
values
  (
    '10000000-0000-4000-8000-000000000001'::uuid,
    '00000001-0000-4000-8000-000000000001'::uuid,
    'text',
    'external',
    'text',
    'feed pruning test fixture'
  ),
  (
    '10000000-0000-4000-8000-000000000002'::uuid,
    '00000001-0000-4000-8000-000000000001'::uuid,
    'text',
    'external',
    'text',
    'feed post deletion test fixture'
  );

insert into public.feed_sessions (
  id,
  viewer_user_id,
  anonymous_key_hash,
  algorithm_version_id,
  created_at,
  expires_at
)
values
  (
    '20000000-0000-4000-8000-000000000001'::uuid,
    null,
    repeat('a', 64),
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now() - interval '5 days',
    now() - interval '3 days'
  ),
  (
    '20000000-0000-4000-8000-000000000002'::uuid,
    '00000001-0000-4000-8000-000000000001'::uuid,
    null,
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  ),
  (
    '20000000-0000-4000-8000-000000000003'::uuid,
    '00000002-0000-4000-8000-000000000002'::uuid,
    null,
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  ),
  (
    '20000000-0000-4000-8000-000000000004'::uuid,
    null,
    repeat('d', 64),
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  );

insert into public.feed_session_items (
  session_id,
  post_id,
  position,
  candidate_source,
  final_score
)
select
  sessions.id,
  '10000000-0000-4000-8000-000000000001'::uuid,
  0,
  'recent',
  1.0
from public.feed_sessions AS sessions
where sessions.id in (
  '20000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000002'::uuid,
  '20000000-0000-4000-8000-000000000003'::uuid
);

insert into public.feed_session_items (
  session_id,
  post_id,
  position,
  candidate_source,
  final_score
)
values (
  '20000000-0000-4000-8000-000000000004'::uuid,
  '10000000-0000-4000-8000-000000000002'::uuid,
  0,
  'recent',
  1.0
);

insert into public.feed_events (
  id,
  client_event_id,
  session_id,
  session_item_id,
  viewer_user_id,
  anonymous_key_hash,
  post_id,
  creator_user_id,
  event_type,
  source_surface,
  position,
  occurred_at
)
select
  case sessions.id
    when '20000000-0000-4000-8000-000000000001'::uuid
      then '30000000-0000-4000-8000-000000000001'::uuid
    when '20000000-0000-4000-8000-000000000002'::uuid
      then '30000000-0000-4000-8000-000000000002'::uuid
    else '30000000-0000-4000-8000-000000000003'::uuid
  end,
  'feed-prune-test-' || sessions.id::text,
  sessions.id,
  items.id,
  sessions.viewer_user_id,
  sessions.anonymous_key_hash,
  items.post_id,
  '00000001-0000-4000-8000-000000000001'::uuid,
  'impression',
  'showcase',
  items.position,
  now()
from public.feed_sessions AS sessions
join public.feed_session_items AS items on items.session_id = sessions.id
where sessions.id in (
  '20000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000002'::uuid,
  '20000000-0000-4000-8000-000000000003'::uuid
);

insert into public.feed_events (
  id,
  client_event_id,
  session_id,
  session_item_id,
  viewer_user_id,
  anonymous_key_hash,
  post_id,
  creator_user_id,
  event_type,
  source_surface,
  position,
  occurred_at
)
select
  '30000000-0000-4000-8000-000000000004'::uuid,
  'feed-post-delete-test',
  sessions.id,
  items.id,
  null,
  sessions.anonymous_key_hash,
  items.post_id,
  '00000001-0000-4000-8000-000000000001'::uuid,
  'impression',
  'showcase',
  items.position,
  now()
from public.feed_sessions AS sessions
join public.feed_session_items AS items on items.session_id = sessions.id
where sessions.id = '20000000-0000-4000-8000-000000000004'::uuid;

create temporary table feed_prune_test_result (summary jsonb) on commit drop;

select lives_ok(
  $$
    insert into feed_prune_test_result (summary)
    select public.prune_feed_personalization_data(now(), 90, 2, 5000)
  $$,
  'bounded pruning deletes an expired session without tripping feed event validation'
);

select results_eq(
  $$select (summary ->> 'sessions_deleted')::integer from feed_prune_test_result$$,
  $$values (1)$$,
  'pruning reports the deleted session'
);

select is(
  (select count(*)::integer from public.feed_sessions where id = '20000000-0000-4000-8000-000000000001'::uuid),
  0,
  'the expired session is removed'
);

select is(
  (select count(*)::integer from public.feed_session_items where session_id = '20000000-0000-4000-8000-000000000001'::uuid),
  0,
  'the expired session items are removed'
);

select is(
  (select count(*)::integer from public.feed_events where id = '30000000-0000-4000-8000-000000000001'::uuid),
  1,
  'recent telemetry survives session retention cleanup'
);

select is(
  (
    select session_id is null and session_item_id is null
    from public.feed_events
    where id = '30000000-0000-4000-8000-000000000001'::uuid
  ),
  true,
  'retained telemetry is detached from both expired session references'
);

select lives_ok(
  $$delete from public.feed_sessions where id = '20000000-0000-4000-8000-000000000002'::uuid$$,
  'direct user-session deletion safely detaches retained telemetry while the account exists'
);

select is(
  (
    select session_id is null and session_item_id is null
    from public.feed_events
    where id = '30000000-0000-4000-8000-000000000002'::uuid
  ),
  true,
  'the delete trigger covers session deletions outside the pruning RPC'
);

select lives_ok(
  $$delete from public.posts where id = '10000000-0000-4000-8000-000000000002'::uuid$$,
  'direct post deletion removes feed telemetry before item cascades'
);

select is(
  (
    select count(*)::integer
    from public.feed_session_items
    where session_id = '20000000-0000-4000-8000-000000000004'::uuid
  ),
  0,
  'direct post deletion removes the linked feed item'
);

select is(
  (select count(*)::integer from public.feed_events where id = '30000000-0000-4000-8000-000000000004'::uuid),
  0,
  'direct post deletion removes the linked feed event'
);

select is(
  pg_catalog.has_table_privilege(
    'supabase_auth_admin',
    'public.feed_events',
    'UPDATE'
  )
  or pg_catalog.has_table_privilege(
    'supabase_auth_admin',
    'public.feed_events',
    'DELETE'
  ),
  false,
  'the production auth role lacks direct feed event mutation privileges'
);

select lives_ok(
  $$delete from auth.users where id = '00000002-0000-4000-8000-000000000002'::uuid$$,
  'viewer account deletion can cascade through feed sessions and events'
);

select is(
  (select count(*)::integer from public.feed_sessions where id = '20000000-0000-4000-8000-000000000003'::uuid),
  0,
  'viewer account deletion removes its feed session'
);

select is(
  (select count(*)::integer from public.feed_events where id = '30000000-0000-4000-8000-000000000003'::uuid),
  0,
  'viewer account deletion removes its feed event'
);

select lives_ok(
  $$delete from auth.users where id = '00000001-0000-4000-8000-000000000001'::uuid$$,
  'creator account deletion can cascade through posts, feed items, and events'
);

select is(
  (select count(*)::integer from public.posts where id = '10000000-0000-4000-8000-000000000001'::uuid),
  0,
  'creator account deletion removes the owned post'
);

select is(
  (select count(*)::integer from public.feed_events where id = '30000000-0000-4000-8000-000000000001'::uuid),
  0,
  'creator account deletion removes retained anonymous telemetry'
);

select is(
  (select count(*)::integer from public.feed_events where id = '30000000-0000-4000-8000-000000000002'::uuid),
  0,
  'creator account deletion removes retained user telemetry'
);

select * from finish();
rollback;

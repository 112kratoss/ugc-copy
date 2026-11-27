-- The mobile app's error reports (audit 2026-11-27): no client access, appended and read by the
-- service role, pruned after 30 days by a supplementary retention step, gone with their account.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.mobile_client_errors'::regclass),
  'mobile_client_errors has row-level security enabled'
);
select has_index('public', 'mobile_client_errors', 'mobile_client_errors_created_idx', 'the retention sweep is indexed by time');
select has_index('public', 'mobile_client_errors', 'mobile_client_errors_user_idx', 'the account cascade is indexed');

select ok(not has_table_privilege('anon', 'public.mobile_client_errors', 'SELECT'), 'anon cannot read error reports');
select ok(not has_table_privilege('anon', 'public.mobile_client_errors', 'INSERT'), 'anon cannot write error reports');
select ok(not has_table_privilege('authenticated', 'public.mobile_client_errors', 'SELECT'), 'authenticated cannot read error reports');
select ok(not has_table_privilege('authenticated', 'public.mobile_client_errors', 'INSERT'), 'authenticated cannot write error reports');
select ok(has_table_privilege('service_role', 'public.mobile_client_errors', 'SELECT'), 'the service role reads error reports');
select ok(has_table_privilege('service_role', 'public.mobile_client_errors', 'INSERT'), 'the service role appends error reports');
select ok(not has_table_privilege('service_role', 'public.mobile_client_errors', 'UPDATE'), 'no role changes a report');
select ok(not has_table_privilege('service_role', 'public.mobile_client_errors', 'DELETE'), 'rows leave only through the prune');
select ok(
  not has_function_privilege('authenticated', 'public.prune_mobile_client_errors(integer)', 'EXECUTE'),
  'authenticated cannot run the prune'
);
select ok(
  has_function_privilege('service_role', 'public.prune_mobile_client_errors(integer)', 'EXECUTE'),
  'the service role runs the prune'
);

-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('ce100000-0000-4000-8000-000000000001'::uuid, 'client-errors@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

insert into public.mobile_client_errors (created_at, user_id, platform, app_version, update_id, route, fatal, message, stack) values
  (now() - interval '31 days', null, 'android', '0.1.9', 'a17f193a', '/', false, 'old guest error', null),
  (now() - interval '31 days', 'ce100000-0000-4000-8000-000000000001', 'ios', '0.1.9', null, '/support', true, 'old account error', 'at render'),
  (now() - interval '29 days', null, 'ios', '0.1.9', null, '/', false, 'recent guest error', null),
  (now(), 'ce100000-0000-4000-8000-000000000001', 'android', '0.1.9', null, '/pricing', false, 'new account error', null);

select throws_ok(
  $$insert into public.mobile_client_errors (platform, message) values ('web', 'x')$$,
  '23514', null, 'only the two phone platforms are taken'
);
select throws_ok(
  $$insert into public.mobile_client_errors (platform, message) values ('ios', '')$$,
  '23514', null, 'an empty message is refused'
);
select throws_ok(
  $$insert into public.mobile_client_errors (platform, message) values ('ios', repeat('x', 501))$$,
  '23514', null, 'a message over 500 characters is refused'
);

select is(public.prune_mobile_client_errors(5000), 2, 'the prune removes the rows older than 30 days');
select is(
  (select array_agg(message order by message) from public.mobile_client_errors),
  array['new account error', 'recent guest error'],
  'rows within 30 days stay'
);

delete from auth.users where id = 'ce100000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.mobile_client_errors where user_id = 'ce100000-0000-4000-8000-000000000001'),
  0,
  'deleting the account removes its reports'
);

select * from finish();
rollback;

-- get_operational_table_growth (20261104140642) reports the tables the usage
-- audit found growing unwatched, auth.users, and the exact number of live
-- guest identities.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'public.get_operational_table_growth()'::regprocedure),
  'the growth report runs as its owner, so it can read auth.users'
);
select is(
  pg_catalog.has_function_privilege('anon', 'public.get_operational_table_growth()', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'public.get_operational_table_growth()', 'EXECUTE'),
  false,
  'no client reads it'
);
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.get_operational_table_growth()', 'EXECUTE'),
  'the ops reports can'
);

select is(
  (select array_agg(watched order by watched)
   from unnest(array[
     'ai_usage_events', 'auth.users', 'backend_job_locks', 'feed_viewer_daily', 'guest_identities',
     'mobile_notifications', 'mobile_push_deliveries', 'onboarding_events', 'playback_metrics',
     'playback_metrics_daily_rollup'
   ]) as watched
   where watched not in (select growth.table_name from public.get_operational_table_growth() as growth)),
  null,
  'every blind spot the audit named is reported'
);

select ok(
  (select count(*) = 26 from public.get_operational_table_growth() as growth
   where growth.table_name not in ('auth.users', 'guest_identities')),
  'every table reported before is still reported'
);

create temporary table guests_before on commit drop as
select growth.live_rows from public.get_operational_table_growth() as growth
where growth.table_name = 'guest_identities';

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('9e000000-0000-4000-8000-000000000001', null, 'authenticated', 'authenticated', true, '{}', '{}', now(), now()),
  ('9e000000-0000-4000-8000-000000000002', null, 'authenticated', 'authenticated', true, '{}', '{}', now(), now()),
  ('9e000000-0000-4000-8000-000000000003', 'growth-fixture@example.invalid', 'authenticated', 'authenticated', false, '{}', '{}', now(), now());

select is(
  (select growth.live_rows from public.get_operational_table_growth() as growth
   where growth.table_name = 'guest_identities') - (select live_rows from guests_before),
  2::bigint,
  'guest identities are counted exactly: the two guests, not the account'
);

select is(
  (select growth.total_bytes from public.get_operational_table_growth() as growth
   where growth.table_name = 'guest_identities'),
  0::bigint,
  'guest identities add no bytes of their own: they are part of auth.users'
);

select ok(
  (select growth.total_bytes > 0 from public.get_operational_table_growth() as growth
   where growth.table_name = 'auth.users'),
  'auth.users reports its size like any table'
);

select * from finish();
rollback;

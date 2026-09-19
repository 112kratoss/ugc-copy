-- Fleet playback metrics are anonymous aggregates written by the service role
-- from /api/mobile/playback-metrics. Nothing signed in may read or write them,
-- and the daily view must summarise what the app sends.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

select has_table('public', 'playback_metrics', 'playback metrics have a table');
select has_view('public', 'playback_metrics_daily', 'playback metrics have a daily view');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.playback_metrics'::regclass),
  'playback_metrics has row level security enabled'
);

select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'playback_metrics'
      and grantee in ('anon', 'authenticated')),
  0::bigint,
  'anon and authenticated hold no privilege on playback_metrics'
);

select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'playback_metrics_daily'
      and grantee in ('anon', 'authenticated')),
  0::bigint,
  'anon and authenticated hold no privilege on playback_metrics_daily'
);

select ok(
  has_table_privilege('service_role', 'public.playback_metrics', 'INSERT'),
  'the service role inserts playback metrics'
);

select ok(
  has_table_privilege('service_role', 'public.playback_metrics_daily', 'SELECT'),
  'the service role reads the daily view'
);

select throws_ok(
  $$ insert into public.playback_metrics
       (session_id, platform, os_version, network, span_ms, surface, start_kind, starts, start_total_ms, start_max_ms, stalls, stall_total_ms, stall_max_ms)
     values ('abcdefgh-1234', 'web', '15', 'wifi', 1000, 'feed', 'cold', 1, 100, 100, 0, 0, 0) $$,
  '23514',
  null,
  'an unknown platform is refused'
);

select throws_ok(
  $$ insert into public.playback_metrics
       (session_id, platform, os_version, network, span_ms, surface, start_kind, starts, start_total_ms, start_max_ms, start_samples, stalls, stall_total_ms, stall_max_ms)
     values ('abcdefgh-1234', 'ios', '26.0', 'wifi', 1000, 'feed', 'cold', 40, 4000, 100,
             array_fill(100, array[33]), 0, 0, 0) $$,
  '23514',
  null,
  'more than 32 start samples are refused'
);

insert into public.playback_metrics
  (received_at, session_id, platform, os_version, network, span_ms, surface, start_kind, starts, start_total_ms, start_max_ms, start_samples, stalls, stall_total_ms, stall_max_ms)
values
  ('2026-09-19 10:00:00+00', 'session-aaaa', 'android', '15', 'wifi', 60000, 'viewer', 'warm', 4, 200, 90, '{30,40,50,80}', 1, 800, 800),
  ('2026-09-19 11:00:00+00', 'session-bbbb', 'android', '15', 'wifi', 30000, 'viewer', 'warm', 2, 300, 200, '{100,200}', 0, 0, 0),
  ('2026-09-19 11:30:00+00', 'session-cccc', 'ios', '26.0', 'cellular', 30000, 'feed', 'cold', 3, 900, 500, '{200,200,500}', 2, 3000, 2000);

select is(
  (select sessions from public.playback_metrics_daily
    where day = '2026-09-19 00:00:00+00' and platform = 'android' and network = 'wifi' and surface = 'viewer' and start_kind = 'warm'),
  2::bigint,
  'the daily view counts sessions per platform, network, surface and start kind'
);

select is(
  (select start_p50_ms from public.playback_metrics_daily
    where day = '2026-09-19 00:00:00+00' and platform = 'android' and network = 'wifi' and surface = 'viewer' and start_kind = 'warm'),
  65::double precision,
  'the daily view pools the sessions'' start samples for percentiles'
);

select is(
  (select stalls_per_start from public.playback_metrics_daily
    where day = '2026-09-19 00:00:00+00' and platform = 'ios' and network = 'cellular' and surface = 'feed' and start_kind = 'cold'),
  0.6667::numeric,
  'the daily view reports stalls per start'
);

select * from finish();

rollback;

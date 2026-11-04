-- prune_operational_backend_data's phases for the tables that had no
-- retention (20261104135403): playback metrics behind a daily rollup,
-- onboarding events, settled AI usage payloads, unread alerts and expired job
-- locks. Every fixture is dated relative to now(), against the defaults.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- ─── Privilege boundary ──────────────────────────────────────────────────────

select ok(
  (select prosecdef and proconfig @> array['search_path=public, pg_temp']
   from pg_catalog.pg_proc
   where oid = 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer)'::regprocedure),
  'the widened sweep runs as its owner with a fixed search path'
);
select is(
  (select count(*)::integer from pg_catalog.pg_proc
   where proname = 'prune_operational_backend_data' and pronamespace = 'public'::regnamespace),
  1,
  'only one signature remains, so a named call is never ambiguous'
);
select is(
  pg_catalog.has_function_privilege('anon', 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer)', 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer)', 'EXECUTE'),
  false,
  'no client can run the sweep'
);
select ok(
  pg_catalog.has_function_privilege('service_role', 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer, integer)', 'EXECUTE'),
  'the retention job can'
);
select is(
  pg_catalog.has_table_privilege('authenticated', 'public.playback_metrics_daily_rollup', 'SELECT')
    or pg_catalog.has_table_privilege('anon', 'public.playback_metrics_daily_rollup', 'SELECT'),
  false,
  'no client reads the playback rollup'
);
select is(
  pg_catalog.has_table_privilege('service_role', 'public.playback_metrics_daily_rollup', 'INSERT')
    or pg_catalog.has_table_privilege('service_role', 'public.playback_metrics_daily_rollup', 'UPDATE')
    or pg_catalog.has_table_privilege('service_role', 'public.playback_metrics_daily_rollup', 'DELETE'),
  false,
  'the service role only reads the rollup; the sweep writes it'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.playback_metrics_daily_rollup'::regclass),
  'the rollup has row level security on'
);
select throws_ok(
  $$ select public.prune_operational_backend_data(p_ai_usage_payload_retention_days => 0) $$,
  'operational retention windows must be at least one day',
  'a zero window on a new phase is refused too'
);
select throws_ok(
  $$ select public.prune_operational_backend_data(now(), 0, 7, 2, 14, 30, 60, 5000) $$,
  'operational retention windows must be at least one day',
  'the old positional call still reaches the same function'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

-- The playback tables are compared whole, so they start empty here.
delete from public.playback_metrics;
delete from public.playback_metrics_daily_rollup;

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  'ab000000-0000-4000-8000-000000000001', 'retention-fixture@example.invalid',
  'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '2 years', now()
);

-- Playback: two sessions a day on four UTC days, the oldest past the window.
create temporary table playback_fixture_days (label text, day timestamptz) on commit drop;
insert into playback_fixture_days values
  ('old', date_trunc('day', now(), 'UTC') - interval '120 days'),
  ('kept', date_trunc('day', now(), 'UTC') - interval '30 days'),
  ('yesterday', date_trunc('day', now(), 'UTC') - interval '1 day'),
  ('today', date_trunc('day', now(), 'UTC'));

insert into public.playback_metrics (
  received_at, session_id, platform, os_version, network, span_ms, surface, start_kind,
  starts, start_total_ms, start_max_ms, start_samples, stalls, stall_total_ms, stall_max_ms
)
select
  days.day + make_interval(hours => session_index * 3),
  'fixture-' || days.label || '-' || session_index,
  case when session_index = 1 then 'ios' else 'android' end,
  '18.0', 'wifi', 60000, 'feed', 'cold',
  4, 400 * session_index, 150 * session_index,
  array[80, 90, 100 * session_index, 120 * session_index],
  session_index, 50 * session_index, 40 * session_index
from playback_fixture_days as days
cross join generate_series(1, 2) as session_index;

create temporary table playback_view_before on commit drop as
select * from public.playback_metrics_daily;

-- Onboarding events: one past the year, one inside it.
insert into public.onboarding_events (
  client_event_id, installation_id, flow_version, platform, event_name, occurred_at, created_at
) values
  ('ab0e0000-0000-4000-8000-000000000001', 'fid_' || repeat('ab', 32), 1, 'ios', 'started',
   now() - interval '400 days', now() - interval '400 days'),
  ('ab0e0000-0000-4000-8000-000000000002', 'fid_' || repeat('ab', 32), 1, 'ios', 'skipped',
   now() - interval '300 days', now() - interval '300 days');

-- AI usage: settled and old (cleared), settled and recent (kept), pending and
-- old (kept: it is not settled), refunded and old (cleared).
insert into public.ai_usage_events (
  id, user_id, feature, provider, model, medium, cost, status, refunded,
  input_prompt, output_text, response_payload, created_at
) values
  ('ab0a0000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001',
   'prompt_enhancement', 'kie', 'gemini-3-flash', 'image', 0, 'succeeded', false,
   'old prompt', 'old output', '{"enhancedPrompt":"old output"}', now() - interval '120 days'),
  ('ab0a0000-0000-4000-8000-000000000002', 'ab000000-0000-4000-8000-000000000001',
   'prompt_enhancement', 'kie', 'gemini-3-flash', 'image', 0, 'succeeded', false,
   'recent prompt', 'recent output', '{"enhancedPrompt":"recent output"}', now() - interval '10 days'),
  ('ab0a0000-0000-4000-8000-000000000003', 'ab000000-0000-4000-8000-000000000001',
   'workflow_blueprint', 'kie', 'gemini-3-flash', 'video', 0, 'pending', false,
   'stuck prompt', null, null, now() - interval '120 days'),
  ('ab0a0000-0000-4000-8000-000000000004', 'ab000000-0000-4000-8000-000000000001',
   'workflow_assistant', 'kie', 'gemini-3-flash', null, 0, 'refunded', true,
   'refunded prompt', '', null, now() - interval '200 days');

-- Alerts: unread past the year (deleted), unread inside it (kept), read past
-- the year (the push job's to prune, not this one's).
insert into public.mobile_notifications (
  id, user_id, type, category, title, body, is_read, created_at, updated_at, last_event_at
) values
  ('ab0c0000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001',
   'generation_succeeded', 'generation', 'Ready', 'Your image is ready', false,
   now() - interval '400 days', now() - interval '400 days', now() - interval '400 days'),
  ('ab0c0000-0000-4000-8000-000000000002', 'ab000000-0000-4000-8000-000000000001',
   'generation_succeeded', 'generation', 'Ready', 'Your image is ready', false,
   now() - interval '300 days', now() - interval '300 days', now() - interval '300 days'),
  ('ab0c0000-0000-4000-8000-000000000003', 'ab000000-0000-4000-8000-000000000001',
   'generation_succeeded', 'generation', 'Ready', 'Your image is ready', true,
   now() - interval '400 days', now() - interval '400 days', now() - interval '400 days');

-- Locks: long expired (deleted), just expired (kept), held (kept).
insert into public.backend_job_locks (name, locked_until, locked_by, updated_at) values
  ('retention-fixture:long-expired', now() - interval '2 days', 'fixture', now() - interval '2 days'),
  ('retention-fixture:just-expired', now() - interval '1 hour', 'fixture', now() - interval '1 hour'),
  ('retention-fixture:held', now() + interval '1 minute', 'fixture', now());

-- ─── Sweep ───────────────────────────────────────────────────────────────────

create temporary table unbounded_retention_result (summary jsonb) on commit drop;

select lives_ok(
  $$ insert into unbounded_retention_result select public.prune_operational_backend_data() $$,
  'the sweep runs with default windows'
);

-- Playback.
select is(
  (select array_agg(rollup.day order by rollup.day) from (select distinct day from public.playback_metrics_daily_rollup) as rollup),
  (select array_agg(day order by day) from playback_fixture_days where label <> 'today'),
  'every finished UTC day is rolled up, and today is not'
);
select is(
  (select count(*)::integer from public.playback_metrics
   where received_at < date_trunc('day', now(), 'UTC') - interval '90 days'),
  0,
  'raw playback rows of days past the window are deleted'
);
select is(
  (select count(*)::integer from public.playback_metrics),
  6,
  'raw rows inside the window, yesterday''s and today''s, are kept'
);
select results_eq(
  $$ select * from public.playback_metrics_daily order by day, platform, network, surface, start_kind $$,
  $$ select * from playback_view_before order by day, platform, network, surface, start_kind $$,
  'the daily view shows the same numbers before and after, the pruned day included'
);
select is(
  (select (summary ->> 'playback_days_rolled_up')::integer from unbounded_retention_result),
  3,
  'the summary counts the days rolled up'
);
select is(
  (select (summary ->> 'playback_metrics_deleted')::integer from unbounded_retention_result),
  2,
  'the summary counts the raw rows deleted'
);

-- Onboarding.
select is(
  (select array_agg(client_event_id order by client_event_id) from public.onboarding_events
   where client_event_id::text like 'ab0e0000-%'),
  array['ab0e0000-0000-4000-8000-000000000002']::uuid[],
  'an onboarding event past the year is deleted and a younger one kept'
);

-- AI usage.
select ok(
  (select input_prompt is null and output_text is null and response_payload is null
     and cost = 0 and status = 'succeeded' and refunded = false and feature = 'prompt_enhancement'
     and model = 'gemini-3-flash' and created_at < now() - interval '119 days'
   from public.ai_usage_events where id = 'ab0a0000-0000-4000-8000-000000000001'),
  'a settled event past 90 days loses its text and keeps its accounting'
);
select ok(
  (select input_prompt = 'recent prompt' and output_text = 'recent output' and response_payload is not null
   from public.ai_usage_events where id = 'ab0a0000-0000-4000-8000-000000000002'),
  'a recent settled event keeps its text, so a replay still answers'
);
select ok(
  (select input_prompt = 'stuck prompt'
   from public.ai_usage_events where id = 'ab0a0000-0000-4000-8000-000000000003'),
  'a pending event is never cleared'
);
select ok(
  (select input_prompt is null and output_text is null and refunded and status = 'refunded'
   from public.ai_usage_events where id = 'ab0a0000-0000-4000-8000-000000000004'),
  'a refunded event is cleared and stays refunded'
);
select is(
  (select (summary ->> 'ai_usage_payloads_cleared')::integer from unbounded_retention_result),
  2,
  'the summary counts the cleared events'
);

-- Alerts.
select is(
  (select array_agg(id order by id) from public.mobile_notifications where id::text like 'ab0c0000-%'),
  array['ab0c0000-0000-4000-8000-000000000002', 'ab0c0000-0000-4000-8000-000000000003']::uuid[],
  'an unread alert untouched for a year is deleted; a younger one and a read one are not'
);

-- Locks.
select is(
  (select array_agg(name order by name) from public.backend_job_locks where name like 'retention-fixture:%'),
  array['retention-fixture:held', 'retention-fixture:just-expired'],
  'a lock a day past its expiry is deleted; a held one and a just-expired one are not'
);
select ok(
  public.try_acquire_backend_job_lock('retention-fixture:long-expired', 60, 'fixture-2'),
  'a deleted lock is acquired afresh, as an expired one was'
);

select is(
  (select (summary ->> 'total_deleted')::integer >= 5 and summary ? 'expired_job_locks_deleted'
     and summary ? 'unread_notifications_deleted' and summary ? 'onboarding_events_deleted'
   from unbounded_retention_result),
  true,
  'the summary names every new phase'
);

-- ─── A caller's clock ahead of the database's ────────────────────────────────

-- Asked as of tomorrow, the sweep still treats today as unfinished: today's
-- raw rows are neither rolled up nor pruned.
select lives_ok(
  $$ select public.prune_operational_backend_data(p_now => now() + interval '2 days') $$,
  'a sweep asked as of the day after tomorrow runs'
);
select is(
  (select count(*)::integer from public.playback_metrics_daily_rollup
   where day = date_trunc('day', now(), 'UTC')),
  0,
  'today is not rolled up while it still takes rows, whatever the caller''s clock says'
);
select is(
  (select count(*)::integer from public.playback_metrics
   where received_at >= date_trunc('day', now(), 'UTC') and session_id like 'fixture-today-%'),
  2,
  'and today''s raw rows are all still there'
);
-- Two days ahead is past the one-day window of a lock still held (until a
-- minute from now) and of one that expired an hour ago: the database's clock
-- keeps both, as it keeps the lock re-acquired above.
select is(
  (select array_agg(name order by name) from public.backend_job_locks where name like 'retention-fixture:%'),
  array['retention-fixture:held', 'retention-fixture:just-expired', 'retention-fixture:long-expired'],
  'no lock is deleted by a caller''s clock ahead of the database''s, least of all one still held'
);

-- ─── A finished day is rolled up once ────────────────────────────────────────

-- A row that somehow lands in a day already rolled up does not reopen it: its
-- raw rows may be partly gone, so recomputing could only lose numbers.
insert into public.playback_metrics (
  received_at, session_id, platform, os_version, network, span_ms, surface, start_kind,
  starts, start_total_ms, start_max_ms, start_samples, stalls, stall_total_ms, stall_max_ms
)
select day + interval '20 hours', 'fixture-late-row', 'ios', '18.0', 'wifi', 1, 'feed', 'cold',
  1, 1, 1, array[1], 0, 0, 0
from playback_fixture_days where label = 'yesterday';

select lives_ok(
  $$ select public.prune_operational_backend_data() $$,
  'a second sweep runs'
);
select is(
  (select sessions from public.playback_metrics_daily_rollup as rollup
   join playback_fixture_days as days on days.day = rollup.day and days.label = 'yesterday'
   where rollup.platform = 'ios'),
  1::bigint,
  'a rolled-up day is not recomputed'
);

-- ─── Batches ─────────────────────────────────────────────────────────────────

-- Only these three are prunable locks, so the batch can only take from them.
delete from public.backend_job_locks where locked_until < now() - interval '1 day';
insert into public.backend_job_locks (name, locked_until, locked_by)
select 'retention-fixture:batch-' || n, now() - interval '3 days', 'fixture'
from generate_series(1, 3) as n;

select is(
  (select (public.prune_operational_backend_data(p_max_deletes_per_table => 2) ->> 'batch_limit_reached')::boolean),
  true,
  'a full batch on a new phase reports that more remains'
);
select is(
  (select count(*)::integer from public.backend_job_locks where name like 'retention-fixture:batch-%'),
  1,
  'and deleted no more than the batch'
);

select * from finish();
rollback;

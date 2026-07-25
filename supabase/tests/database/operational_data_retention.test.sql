begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

-- ─── Privilege boundary ──────────────────────────────────────────────────────

select is(
  (
    select procedures.prosecdef
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer)'::regprocedure
  ),
  true,
  'the retention sweep runs with its owner privileges'
);

select is(
  (
    select pg_catalog.has_function_privilege('anon', procedures.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer)'::regprocedure
  ),
  false,
  'client roles cannot invoke the retention sweep'
);

select is(
  (
    select pg_catalog.has_function_privilege('service_role', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.prune_operational_backend_data(timestamptz, integer, integer, integer, integer, integer, integer, integer)'::regprocedure
  ),
  true,
  'the service role can invoke the retention sweep'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

insert into public.backend_job_runs (id, job_name, route, request_id, lock_owner, status, started_at, finished_at)
values
  -- skipped, older than the 7-day skipped window: prunable
  ('40000000-0000-4000-8000-000000000001'::uuid, 'feed-maintenance', '/api/cron/feed-maintenance',
   'req-old-skip', 'owner-1', 'skipped', now() - interval '20 days', now() - interval '20 days'),
  -- skipped but recent: retained
  ('40000000-0000-4000-8000-000000000002'::uuid, 'feed-maintenance', '/api/cron/feed-maintenance',
   'req-new-skip', 'owner-2', 'skipped', now() - interval '2 days', now() - interval '2 days'),
  -- succeeded, older than the skipped window but inside the 30-day window: retained
  ('40000000-0000-4000-8000-000000000003'::uuid, 'generation-completions', '/api/cron/generation-completions',
   'req-mid-success', 'owner-3', 'succeeded', now() - interval '20 days', now() - interval '20 days'),
  -- succeeded, older than the 30-day window: prunable
  ('40000000-0000-4000-8000-000000000004'::uuid, 'generation-completions', '/api/cron/generation-completions',
   'req-old-success', 'owner-4', 'succeeded', now() - interval '40 days', now() - interval '40 days'),
  -- failed and ancient: prunable, but proves failures use the long window
  ('40000000-0000-4000-8000-000000000005'::uuid, 'mobile-push-receipts', '/api/cron/mobile-push-receipts',
   'req-old-failed', 'owner-5', 'failed', now() - interval '40 days', now() - interval '40 days'),
  -- started and never finished: retained at any age so stuck runs stay visible
  ('40000000-0000-4000-8000-000000000006'::uuid, 'feed-maintenance', '/api/cron/feed-maintenance',
   'req-stuck', 'owner-6', 'started', now() - interval '99 days', null);

insert into public.backend_rate_limits (scope, subject_key, window_start, request_count)
values
  ('test:prune', 'subject-old', now() - interval '10 days', 3),
  ('test:prune', 'subject-new', now() - interval '1 hour', 5);

insert into public.generation_completion_jobs (id, prediction_id, status, created_at, updated_at, completed_at)
values
  ('50000000-0000-4000-8000-000000000001'::uuid, 'task-old-success', 'succeeded',
   now() - interval '30 days', now() - interval '30 days', now() - interval '30 days'),
  ('50000000-0000-4000-8000-000000000002'::uuid, 'task-recent-success', 'succeeded',
   now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'),
  -- pending forever: still owed work, must never be pruned
  ('50000000-0000-4000-8000-000000000003'::uuid, 'task-stuck-pending', 'pending',
   now() - interval '90 days', now() - interval '90 days', null);

insert into public.provider_dependency_events (id, service_name, outcome, method, timeout_ms, duration_ms, created_at)
values
  ('60000000-0000-4000-8000-000000000001'::uuid, 'Kie status', 'timeout', 'GET', 10000, 10000, now() - interval '45 days'),
  ('60000000-0000-4000-8000-000000000002'::uuid, 'Kie status', 'http_error', 'GET', 10000, 120, now() - interval '2 days');

-- ─── Sweep ───────────────────────────────────────────────────────────────────

create temporary table retention_test_result (summary jsonb) on commit drop;

select lives_ok(
  $$
    insert into retention_test_result (summary)
    select public.prune_operational_backend_data()
  $$,
  'the retention sweep runs with default windows'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000001'::uuid),
  0,
  'a skipped run past the short window is pruned'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000002'::uuid),
  1,
  'a recent skipped run is retained'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000003'::uuid),
  1,
  'a succeeded run inside the long window survives the short skipped window'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000004'::uuid),
  0,
  'a succeeded run past the long window is pruned'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000005'::uuid),
  0,
  'a failed run past the long window is pruned'
);

select is(
  (select count(*)::integer from public.backend_job_runs
   where id = '40000000-0000-4000-8000-000000000006'::uuid),
  1,
  'an unfinished run is retained at any age so stuck jobs stay visible'
);

select is(
  (select count(*)::integer from public.backend_rate_limits
   where scope = 'test:prune' and subject_key = 'subject-old'),
  0,
  'an expired rate-limit window is pruned'
);

select is(
  (select count(*)::integer from public.backend_rate_limits
   where scope = 'test:prune' and subject_key = 'subject-new'),
  1,
  'an active rate-limit window is retained'
);

select is(
  (select count(*)::integer from public.generation_completion_jobs
   where id = '50000000-0000-4000-8000-000000000001'::uuid),
  0,
  'a settled completion job past the window is pruned'
);

select is(
  (select count(*)::integer from public.generation_completion_jobs
   where id = '50000000-0000-4000-8000-000000000002'::uuid),
  1,
  'a recent completion job is retained'
);

select is(
  (select count(*)::integer from public.generation_completion_jobs
   where id = '50000000-0000-4000-8000-000000000003'::uuid),
  1,
  'a pending completion job is never pruned because work is still owed'
);

select is(
  (select count(*)::integer from public.provider_dependency_events
   where id = '60000000-0000-4000-8000-000000000001'::uuid),
  0,
  'provider telemetry past the window is pruned'
);

select is(
  (select count(*)::integer from public.provider_dependency_events
   where id = '60000000-0000-4000-8000-000000000002'::uuid),
  1,
  'recent provider telemetry is retained'
);

select is(
  (select (summary ->> 'job_runs_deleted')::integer >= 3 from retention_test_result),
  true,
  'the summary reports the pruned job runs'
);

select throws_ok(
  $$select public.prune_operational_backend_data(now(), 0, 7, 2, 14, 30, 60, 5000)$$,
  'operational retention windows must be at least one day',
  'a zero retention window is rejected rather than deleting everything'
);

-- ─── Catalog provider checks ─────────────────────────────────────────────────
--
-- Provider-check history is prunable past its window, but the most recent check
-- per model is load-bearing for the catalog and must survive at any age.

insert into public.generation_model_catalog_releases (id, revision, status, defaults)
values (
  'a0000000-0000-4000-8000-000000000001'::uuid,
  'retention-test-revision',
  'draft',
  '{}'::jsonb
);

-- Provider checks carry a composite (release_id, model_id) foreign key, so the
-- catalog entries must exist before the checks can.
insert into public.generation_model_catalog_entries (
  release_id, model_id, public_descriptor, adapter_key,
  provider_model_map, pricing_strategy, pricing_config, validation_strategy
)
values
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'flux-2-pro', '{}'::jsonb, 'image-v1',
   '{}'::jsonb, 'flat', '{}'::jsonb, 'image-v1'),
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'gpt-image-2', '{}'::jsonb, 'image-v1',
   '{}'::jsonb, 'flat', '{}'::jsonb, 'image-v1');

insert into public.generation_model_provider_checks
  (release_id, model_id, provider, status, checked_at)
values
  -- model-x: an older superseded check, then its latest.
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'flux-2-pro', 'kie', 'available', now() - interval '90 days'),
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'flux-2-pro', 'kie', 'available', now() - interval '70 days'),
  -- model-y: a single ancient check that is nonetheless its latest.
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'gpt-image-2', 'kie', 'available', now() - interval '90 days');

create temporary table retention_checks_result (summary jsonb) on commit drop;

select lives_ok(
  $$
    insert into retention_checks_result (summary)
    select public.prune_operational_backend_data()
  $$,
  'the sweep runs against provider-check history'
);

select is(
  (
    select count(*)::integer
    from public.generation_model_provider_checks
    where model_id = 'flux-2-pro'
  ),
  1,
  'the superseded provider check is pruned and the latest is kept'
);

select is(
  (
    select (checked_at < now() - interval '60 days')
    from public.generation_model_provider_checks
    where model_id = 'flux-2-pro'
  ),
  true,
  'the retained check is the latest one even though it is past the window'
);

select is(
  (
    select count(*)::integer
    from public.generation_model_provider_checks
    where model_id = 'gpt-image-2'
  ),
  1,
  'a model whose only check is ancient keeps it'
);

select * from finish();
rollback;

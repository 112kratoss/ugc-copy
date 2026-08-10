-- Real-schema coverage for the queue-age probes used by backend health.
--
-- Unit tests pin the generated PostgREST filters. These assertions make the
-- corresponding SQL shapes execute against the replayed schema so a permissive
-- chain mock cannot hide a reference to a nonexistent lease column.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(2);

select lives_ok(
  $$
    select next_attempt_at
    from public.generation_completion_jobs
    where (
      status = 'pending' and next_attempt_at <= now()
    ) or (
      status = 'processing' and locked_at <= now() - interval '5 minutes'
    )
    order by next_attempt_at asc
    limit 1
  $$,
  'completion queue age uses its real locked_at-only lease contract'
);

select lives_ok(
  $$
    select next_attempt_at
    from public.workflow_run_step_jobs
    where (
      status = 'pending' and next_attempt_at <= now()
    ) or (
      status = 'processing'
      and coalesce(heartbeat_at, locked_at) <= now() - interval '5 minutes'
    )
    order by next_attempt_at asc
    limit 1
  $$,
  'workflow queue age uses its heartbeat-aware lease contract'
);

select * from finish();
rollback;

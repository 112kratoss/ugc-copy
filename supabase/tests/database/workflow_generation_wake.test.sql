-- A provider completion must wake the exact durable workflow ticket. This is
-- the production path that replaces browser polling and the 10-minute fallback.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

select ok(
  has_function_privilege(
    'service_role',
    'public.wake_workflow_run_step_job(uuid)',
    'EXECUTE'
  ),
  'service workers can explicitly wake a workflow run'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.wake_workflow_run_step_job(uuid)',
    'EXECUTE'
  ),
  'clients cannot manipulate workflow scheduling'
);

select has_trigger(
  'public',
  'generations',
  'generations_wake_workflow_runs_after_terminal',
  'generation status transitions have a workflow wake trigger'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'workflow-wake@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.workflow_canvases (id, user_id, title, graph)
values (
  'f2000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'Workflow wake fixture',
  '{"version":1,"nodes":[],"edges":[]}'::jsonb
);

insert into public.workflow_canvas_runs (
  id, canvas_id, user_id, start_node_id, mode, status, created_at
)
values (
  'f3000000-0000-4000-8000-000000000001'::uuid,
  'f2000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'start', 'branch', 'processing', now()
);

insert into public.generations (id, user_id, model, status, category, prompt)
values (
  'f4000000-0000-4000-8000-000000000001'::uuid,
  'f1000000-0000-4000-8000-000000000001'::uuid,
  'workflow-wake-model', 'processing', 'image', 'workflow wake fixture'
);

insert into public.workflow_canvas_run_steps (
  id, run_id, node_id, status, generation_id, started_at
)
values (
  'f5000000-0000-4000-8000-000000000001'::uuid,
  'f3000000-0000-4000-8000-000000000001'::uuid,
  'start', 'processing',
  'f4000000-0000-4000-8000-000000000001'::uuid,
  now()
);

insert into public.workflow_run_step_jobs (
  id, run_id, canvas_id, node_id, attempt, status, next_attempt_at
)
values (
  'f6000000-0000-4000-8000-000000000001'::uuid,
  'f3000000-0000-4000-8000-000000000001'::uuid,
  'f2000000-0000-4000-8000-000000000001'::uuid,
  'start', 1, 'pending', now() + interval '10 minutes'
);

update public.generations
set status = 'succeeded'
where id = 'f4000000-0000-4000-8000-000000000001'::uuid;

select ok(
  (select next_attempt_at <= now()
   from public.workflow_run_step_jobs
   where id = 'f6000000-0000-4000-8000-000000000001'::uuid),
  'a terminal generation makes the deferred ticket immediately due'
);

select is(
  (select count(*) from public.workflow_run_step_jobs
   where run_id = 'f3000000-0000-4000-8000-000000000001'::uuid),
  1::bigint,
  'the wake preserves the existing attempt instead of duplicating it'
);

select is(
  (select attempt from public.workflow_run_step_jobs
   where id = 'f6000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the wake does not spend a retry attempt'
);

update public.generations
set status = 'succeeded'
where id = 'f4000000-0000-4000-8000-000000000001'::uuid;

select is(
  (select count(*) from public.workflow_run_step_jobs
   where run_id = 'f3000000-0000-4000-8000-000000000001'::uuid),
  1::bigint,
  'a duplicate terminal update is idempotent'
);

update public.workflow_run_step_jobs
set status = 'succeeded', completed_at = now()
where id = 'f6000000-0000-4000-8000-000000000001'::uuid;

select ok(
  public.wake_workflow_run_step_job(
    'f3000000-0000-4000-8000-000000000001'::uuid
  ) is not null,
  'an orphaned processing run receives a fresh bounded ticket'
);

select is(
  (select count(*) from public.workflow_run_step_jobs
   where run_id = 'f3000000-0000-4000-8000-000000000001'::uuid
     and status = 'pending' and attempt = 2),
  1::bigint,
  'the recovery ticket advances the immutable attempt number exactly once'
);

update public.workflow_canvas_runs
set status = 'succeeded', finished_at = now()
where id = 'f3000000-0000-4000-8000-000000000001'::uuid;

select is(
  public.wake_workflow_run_step_job(
    'f3000000-0000-4000-8000-000000000001'::uuid
  ),
  null::uuid,
  'terminal workflow runs cannot be re-enqueued'
);

select * from finish();
rollback;

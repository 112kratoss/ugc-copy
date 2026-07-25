-- Behavioural coverage for completion-source attribution.
--
-- `finish_generation_completion_job` settles paid generations, so the added
-- `completed_via` stamp must be provably inert with respect to that settlement:
-- the same statuses, the same retry behaviour, the same lock ownership check.
-- These assertions cover both the new attribution and the old semantics.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('a1000000-0000-4000-8000-000000000001'::uuid, 'completion-source@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.generations (id, user_id, prediction_id, status, model, category)
values
  ('b1000000-0000-4000-8000-000000000001'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'pred-webhook-1', 'processing', 'nano-banana-2', 'image'),
  ('b2000000-0000-4000-8000-000000000002'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'pred-cron-1', 'processing', 'nano-banana-2', 'image'),
  ('b3000000-0000-4000-8000-000000000003'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'pred-retry-1', 'processing', 'nano-banana-2', 'image'),
  ('b4000000-0000-4000-8000-000000000004'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'pred-guard-1', 'processing', 'nano-banana-2', 'image');

-- ─── Inline webhook drain ────────────────────────────────────────────────────

insert into public.generation_completion_jobs (id, prediction_id, status, locked_by, locked_at, attempt_count)
values ('c1000000-0000-4000-8000-000000000001'::uuid, 'pred-webhook-1', 'processing',
        'kie-webhook:pred-webhook-1:1750000000000', now(), 1);

select is(
  public.finish_generation_completion_job(
    'c1000000-0000-4000-8000-000000000001'::uuid,
    'kie-webhook:pred-webhook-1:1750000000000',
    true
  ),
  'succeeded',
  'the inline drain settles the job as succeeded'
);

select is(
  (select completed_via from public.generation_completion_jobs
   where id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  'webhook_drain',
  'a kie-webhook lock owner is attributed to the inline drain'
);

select isnt(
  (select completed_at from public.generation_completion_jobs
   where id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  null,
  'the inline drain still stamps completed_at'
);

select is(
  (select locked_by from public.generation_completion_jobs
   where id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  null,
  'the lock is still released on completion'
);

-- ─── Cron sweep ──────────────────────────────────────────────────────────────

insert into public.generation_completion_jobs (id, prediction_id, status, locked_by, locked_at, attempt_count)
values ('c2000000-0000-4000-8000-000000000002'::uuid, 'pred-cron-1', 'processing',
        'generation-completions:req-abc:1750000000000', now(), 1);

select is(
  public.finish_generation_completion_job(
    'c2000000-0000-4000-8000-000000000002'::uuid,
    'generation-completions:req-abc:1750000000000',
    true
  ),
  'succeeded',
  'the cron sweep settles the job as succeeded'
);

select is(
  (select completed_via from public.generation_completion_jobs
   where id = 'c2000000-0000-4000-8000-000000000002'::uuid),
  'cron_sweep',
  'a backend-job lock owner is attributed to the cron sweep'
);

-- ─── Retries keep the terminal runner, not the intermediate one ──────────────

insert into public.generation_completion_jobs (id, prediction_id, status, locked_by, locked_at, attempt_count)
values ('c3000000-0000-4000-8000-000000000003'::uuid, 'pred-retry-1', 'processing',
        'kie-webhook:pred-retry-1:1750000000000', now(), 1);

select is(
  public.finish_generation_completion_job(
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'kie-webhook:pred-retry-1:1750000000000',
    false,
    'transient provider error'
  ),
  'pending',
  'a non-terminal failure returns the job to pending for another attempt'
);

select is(
  (select completed_via from public.generation_completion_jobs
   where id = 'c3000000-0000-4000-8000-000000000003'::uuid),
  null,
  'a job still awaiting retry is not attributed to any runner'
);

update public.generation_completion_jobs
set status = 'processing', locked_by = 'generation-completions:req-def:1750000100000', locked_at = now()
where id = 'c3000000-0000-4000-8000-000000000003'::uuid;

select is(
  public.finish_generation_completion_job(
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'generation-completions:req-def:1750000100000',
    true
  ),
  'succeeded',
  'the cron sweep can settle a job the inline drain failed to finish'
);

select is(
  (select completed_via from public.generation_completion_jobs
   where id = 'c3000000-0000-4000-8000-000000000003'::uuid),
  'cron_sweep',
  'attribution names the runner that actually finished it, not the one that tried first'
);

-- ─── The lock ownership guard is unchanged ───────────────────────────────────

insert into public.generation_completion_jobs (id, prediction_id, status, locked_by, locked_at, attempt_count)
values ('c4000000-0000-4000-8000-000000000004'::uuid, 'pred-guard-1', 'processing',
        'kie-webhook:owner-a:1750000000000', now(), 1);

select is(
  public.finish_generation_completion_job(
    'c4000000-0000-4000-8000-000000000004'::uuid,
    'kie-webhook:someone-else:1750000000000',
    true
  ),
  'processing',
  'a runner that does not hold the lock cannot settle the job'
);

select is(
  (select completed_via from public.generation_completion_jobs
   where id = 'c4000000-0000-4000-8000-000000000004'::uuid),
  null,
  'a rejected settlement attributes nothing'
);

select throws_ok(
  $$select public.finish_generation_completion_job('c4000000-0000-4000-8000-000000000004'::uuid, '   ', true)$$,
  'locked_by is required',
  'a blank lock owner is still rejected'
);

select is(
  (select count(*)::int from public.generation_completion_jobs
   where completed_via not in ('webhook_drain', 'cron_sweep')),
  0,
  'no job carries a value outside the permitted attribution set'
);

select * from finish();
rollback;

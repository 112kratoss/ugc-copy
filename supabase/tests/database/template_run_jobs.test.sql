-- Template execution must be server-owned, leased and woken by durable state
-- transitions rather than by a browser GET loop.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

select has_table('public', 'template_run_jobs', 'template runs have a durable queue');
select has_trigger(
  'public', 'template_runs', 'template_runs_enqueue_after_state_change',
  'starting or resuming a run creates its ticket'
);
select has_trigger(
  'public', 'generations', 'generations_enqueue_template_run_after_terminal',
  'terminal provider work wakes its template run'
);
select ok(
  not has_table_privilege('authenticated', 'public.template_run_jobs', 'SELECT'),
  'clients cannot inspect internal leases'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'e7100000-0000-4000-8000-000000000001'::uuid,
  'template-worker@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
);

insert into public.templates (id, name, creator_user_id, status, is_active)
values (
  'e7200000-0000-4000-8000-000000000001'::uuid,
  'Durable worker fixture',
  'e7100000-0000-4000-8000-000000000001'::uuid,
  'draft', true
);

insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
)
values (
  'e7300000-0000-4000-8000-000000000001'::uuid,
  'e7200000-0000-4000-8000-000000000001'::uuid,
  'e7100000-0000-4000-8000-000000000001'::uuid,
  '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  repeat('a', 64), '[]'::jsonb, '{}'::jsonb,
  'output', 'image', 'collecting_inputs', 10, 10
);

update public.template_runs
set status = 'queued'
where id = 'e7300000-0000-4000-8000-000000000001'::uuid;

select is(
  (select count(*) from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid
     and status = 'pending'),
  1::bigint,
  'starting a run creates one pending ticket'
);

select is(
  (select count(*) from public.claim_template_run_jobs(1, 'template-worker-a', 300)),
  1::bigint,
  'one worker claims the due ticket'
);

select is(
  (select status || ':' || locked_by from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
  'processing:template-worker-a',
  'claiming establishes one visible owner'
);

select is(
  public.enqueue_template_run_job('e7300000-0000-4000-8000-000000000001'::uuid),
  (select id from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
  'duplicate enqueue returns the same ticket'
);

select is(
  (select status || ':' || locked_by from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
  'processing:template-worker-a',
  'duplicate enqueue cannot revoke a live lease'
);

select is(
  (select count(*) from public.claim_template_run_jobs(1, 'template-worker-b', 300)),
  0::bigint,
  'a second worker cannot claim the live ticket'
);

select is(
  public.defer_template_run_job(
    (select id from public.template_run_jobs
     where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
    'template-worker-a', 600
  ),
  true,
  'the owner can defer a run that is waiting on provider work'
);

insert into public.generations (
  id, user_id, model, status, category, prompt, template_run_id
)
values (
  'e7400000-0000-4000-8000-000000000001'::uuid,
  'e7100000-0000-4000-8000-000000000001'::uuid,
  'template-worker-model', 'processing', 'image', 'durable template fixture',
  'e7300000-0000-4000-8000-000000000001'::uuid
);

update public.template_runs
set status = 'processing'
where id = 'e7300000-0000-4000-8000-000000000001'::uuid;

update public.generations
set status = 'succeeded'
where id = 'e7400000-0000-4000-8000-000000000001'::uuid;

select ok(
  (select next_attempt_at <= now() from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
  'provider completion accelerates the deferred ticket'
);

select is(
  (select count(*) from public.template_run_jobs
   where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
  1::bigint,
  'provider completion does not duplicate the run ticket'
);

select is(
  (select count(*) from public.claim_template_run_jobs(1, 'template-worker-b', 300)),
  1::bigint,
  'the accelerated ticket is immediately claimable'
);

select is(
  public.finish_template_run_job(
    (select id from public.template_run_jobs
     where run_id = 'e7300000-0000-4000-8000-000000000001'::uuid),
    'template-worker-b', true, null, 60, 5
  ),
  'succeeded',
  'the winning owner closes the ticket'
);

select * from finish();
rollback;

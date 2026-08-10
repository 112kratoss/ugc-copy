-- Provider output URLs must survive webhook/status-process death and duplicate
-- callbacks must never revoke the worker importing large media.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

select has_table('public', 'generation_output_import_jobs', 'output persistence has a durable queue');
select ok(
  not has_table_privilege('authenticated', 'public.generation_output_import_jobs', 'SELECT'),
  'clients cannot read temporary provider URLs'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'e8100000-0000-4000-8000-000000000001'::uuid,
  'output-import@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
);
insert into public.generations (id, user_id, prediction_id, model, status, category, prompt)
values (
  'e8200000-0000-4000-8000-000000000001'::uuid,
  'e8100000-0000-4000-8000-000000000001'::uuid,
  'provider-output-task-1', 'output-import-model', 'processing', 'video', 'fixture'
);

select ok(
  public.enqueue_generation_output_import_job(
    'e8200000-0000-4000-8000-000000000001'::uuid,
    '["https://provider.invalid/output.mp4"]'::jsonb,
    now()
  ) is not null,
  'provider success commits its URL to the durable queue'
);
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'import-worker-a', 300)),
  1::bigint,
  'one media worker claims the import'
);
select is(
  (select status || ':' || locked_by from public.generation_output_import_jobs
   where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  'processing:import-worker-a',
  'the claim records one owner'
);
select is(
  public.enqueue_generation_output_import_job(
    'e8200000-0000-4000-8000-000000000001'::uuid,
    '["https://provider.invalid/output.mp4"]'::jsonb,
    now()
  ),
  (select id from public.generation_output_import_jobs
   where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  'a duplicate callback resolves to the same import'
);
select is(
  (select status || ':' || locked_by from public.generation_output_import_jobs
   where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  'processing:import-worker-a',
  'a duplicate callback preserves the live lease'
);
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'import-worker-b', 300)),
  0::bigint,
  'a second worker cannot duplicate the media import'
);
select is(
  public.finish_generation_output_import_job(
    (select id from public.generation_output_import_jobs
     where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
    'import-worker-a', false, 'storage unavailable', 600, 10
  ),
  'retry_scheduled',
  'storage failure schedules a retry without settling or refunding generation credits'
);
select is(
  (select attempt_count from public.generation_output_import_jobs
   where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  1,
  'the failed import increments its own attempt counter'
);
select is(
  (select status from public.generations
   where id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  'processing',
  'provider-completed work remains held rather than being falsely refunded'
);
update public.generation_output_import_jobs
set next_attempt_at = now()
where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid;
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'import-worker-b', 300)),
  1::bigint,
  'the durable retry can be claimed by a new worker'
);
select is(
  public.finish_generation_output_import_job(
    (select id from public.generation_output_import_jobs
     where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
    'import-worker-b', true, null, 60, 10
  ),
  'succeeded',
  'the new owner closes the import after durable persistence'
);
select public.enqueue_generation_output_import_job(
  'e8200000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/changed.mp4"]'::jsonb,
  now()
);
select is(
  (select status from public.generation_output_import_jobs
   where generation_id = 'e8200000-0000-4000-8000-000000000001'::uuid),
  'succeeded',
  'late duplicate callbacks cannot reopen a completed import'
);

select * from finish();
rollback;

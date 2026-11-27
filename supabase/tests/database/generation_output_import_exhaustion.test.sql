-- An exhausted output import is owned by the import pipeline's hourly retry
-- and its 24-hour give-up (generation-output-import-retries.ts). A repeated
-- enqueue from a status check must not reopen it on every tick, and a captured
-- payment that matched nothing is recorded once per payment and reason.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  'e8300000-0000-4000-8000-000000000001'::uuid,
  'output-import-exhaustion@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now()
);
insert into public.generations (id, user_id, prediction_id, model, status, category, prompt)
values (
  'e8400000-0000-4000-8000-000000000001'::uuid,
  'e8300000-0000-4000-8000-000000000001'::uuid,
  'provider-output-exhaustion-1', 'output-import-model', 'processing', 'video', 'fixture'
);

select has_column('public', 'generations', 'provider_sync_attempted_at', 'the reaper records each attempt for rotation');

select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/output.mp4"]'::jsonb,
  now()
);
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'exhaustion-worker', 300)),
  1::bigint,
  'the import is claimed'
);
select is(
  public.finish_generation_output_import_job(
    (select id from public.generation_output_import_jobs
     where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
    'exhaustion-worker', false, 'Remote media host is not allowlisted.', 60, 1
  ),
  'exhausted',
  'the last allowed failure exhausts the import'
);

select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/refreshed.mp4"]'::jsonb,
  now()
);
select is(
  (select status from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  'failed',
  'a repeated enqueue does not reopen an exhausted import'
);
select is(
  (select output_urls from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  '["https://provider.invalid/refreshed.mp4"]'::jsonb,
  'a repeated enqueue still refreshes the URLs the hourly retry will use'
);
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'exhaustion-worker-2', 300)),
  0::bigint,
  'nothing is claimable until the pipeline reopens it'
);
select is(
  public.has_due_generation_output_import_jobs(300),
  false,
  'an exhausted import is not reported as due work'
);

-- The pipeline's hourly reopen is a conditional update of its own.
update public.generation_output_import_jobs
set status = 'pending', next_attempt_at = now(), updated_at = now()
where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid and status = 'failed';
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'exhaustion-worker-3', 300)),
  1::bigint,
  'a reopened import is claimed again'
);

select ok(
  not has_table_privilege('authenticated', 'public.payment_capture_anomalies', 'SELECT'),
  'clients cannot read payment anomalies'
);
insert into public.payment_capture_anomalies (provider, payment_id, order_id, purchase_kind, reason)
values ('razorpay', 'pay_fixture_1', 'order_fixture_1', 'credits', 'amount_mismatch');
select throws_ok(
  $$insert into public.payment_capture_anomalies (provider, payment_id, order_id, purchase_kind, reason)
    values ('razorpay', 'pay_fixture_1', 'order_fixture_1', 'credits', 'amount_mismatch')$$,
  '23505',
  null,
  'a redelivered webhook does not record the same anomaly twice'
);
select ok(
  not has_table_privilege('service_role', 'public.payment_capture_anomalies', 'UPDATE'),
  'the anomaly record is append-only'
);

select * from finish();
rollback;

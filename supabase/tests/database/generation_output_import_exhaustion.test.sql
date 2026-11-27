-- An exhausted output import is owned by the import pipeline's hourly retry
-- and its 24-hour give-up (generation-output-import-retries.ts). A repeated
-- enqueue from a status check must not reopen it on every tick, and a captured
-- payment that matched nothing is recorded once per payment and reason.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

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
  '["https://provider.invalid/output.mp4"]'::jsonb,
  now()
);
select is(
  (select status from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  'failed',
  'a repeated enqueue with the same URLs does not reopen an exhausted import'
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

-- The same file signed again (a new query string) on a later status poll:
-- stored, but not a reason to try again.
select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/output.mp4?sig=second&expires=2"]'::jsonb,
  now()
);
select is(
  (select status || ':' || (output_urls ->> 0) from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  'failed:https://provider.invalid/output.mp4?sig=second&expires=2',
  'the same path with a new query string stays failed, with its URLs refreshed'
);

-- A different file within five minutes of the last failure: stored, not yet tried.
select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/early.mp4"]'::jsonb,
  now()
);
select is(
  (select status || ':' || (output_urls ->> 0) from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  'failed:https://provider.invalid/early.mp4',
  'a different path within five minutes of the last failure stays failed, with its URLs refreshed'
);

-- A different file once five minutes have passed: tried at once.
update public.generation_output_import_jobs
set completed_at = now() - interval '10 minutes'
where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid;
select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000001'::uuid,
  '["https://provider.invalid/refreshed.mp4?sig=x"]'::jsonb,
  now()
);
select is(
  (select status || ':' || attempt_count from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  'pending:1',
  'a different path after five minutes reopens it, keeping its tries'
);
select is(
  (select output_urls from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid),
  '["https://provider.invalid/refreshed.mp4?sig=x"]'::jsonb,
  'the reopened import uses the new URLs'
);
select is(
  public.generation_output_import_url_paths('["https://a.invalid/x.mp4?sig=1#t", "https://a.invalid/y.mp4"]'::jsonb),
  '["https://a.invalid/x.mp4", "https://a.invalid/y.mp4"]'::jsonb,
  'file addresses drop the query string and fragment, in order'
);
update public.generation_output_import_jobs
set status = 'failed', next_attempt_at = now() - interval '1 hour'
where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid;

-- The pipeline's hourly reopen is a conditional update of its own.
update public.generation_output_import_jobs
set status = 'pending', next_attempt_at = now(), updated_at = now()
where generation_id = 'e8400000-0000-4000-8000-000000000001'::uuid and status = 'failed';
select is(
  (select count(*) from public.claim_generation_output_import_jobs(1, 'exhaustion-worker-3', 300)),
  1::bigint,
  'a reopened import is claimed again'
);

-- A worker killed mid-import: each expired lease counts as a try, and the
-- reclaim that would use the last one marks the job failed instead.
insert into public.generations (id, user_id, prediction_id, model, status, category, prompt)
values (
  'e8400000-0000-4000-8000-000000000002'::uuid,
  'e8300000-0000-4000-8000-000000000001'::uuid,
  'provider-output-crash-1', 'output-import-model', 'processing', 'video', 'fixture'
);
select public.enqueue_generation_output_import_job(
  'e8400000-0000-4000-8000-000000000002'::uuid,
  '["https://provider.invalid/crash.mp4"]'::jsonb,
  now()
);
select public.claim_generation_output_import_jobs(25, 'crash-worker-0', 300);
update public.generation_output_import_jobs
set locked_at = now() - interval '10 minutes'
where generation_id = 'e8400000-0000-4000-8000-000000000002'::uuid;
select is(
  (select attempt_count from public.claim_generation_output_import_jobs(25, 'crash-worker-1', 300)
   where generation_id = 'e8400000-0000-4000-8000-000000000002'::uuid),
  1,
  'reclaiming an expired lease counts as an attempt'
);
update public.generation_output_import_jobs
set attempt_count = 9, locked_at = now() - interval '10 minutes'
where generation_id = 'e8400000-0000-4000-8000-000000000002'::uuid;
select is(
  (select count(*) from public.claim_generation_output_import_jobs(25, 'crash-worker-2', 300)
   where generation_id = 'e8400000-0000-4000-8000-000000000002'::uuid),
  0::bigint,
  'the expired lease that would use the last try is not handed out again'
);
select is(
  (select status || ':' || attempt_count || ':' || (completed_at is not null)::text
   from public.generation_output_import_jobs
   where generation_id = 'e8400000-0000-4000-8000-000000000002'::uuid),
  'failed:10:true',
  'it is marked failed, where the hourly retry and the give-up own it'
);

select ok(
  not has_table_privilege('authenticated', 'public.payment_capture_anomalies', 'SELECT'),
  'clients cannot read payment anomalies'
);
insert into public.payment_capture_anomalies (provider, payment_id, order_id, purchase_kind, reason)
values ('razorpay', 'pay_fixture_1', 'order_fixture_1', 'credits', 'amount_mismatch');
insert into public.payment_capture_anomalies (provider, payment_id, order_id, purchase_kind, reason)
values ('razorpay', 'pay_fixture_2', 'order_unknown', 'unknown', 'no_matching_order');
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

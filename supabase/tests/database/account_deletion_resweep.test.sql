-- Durable, leased account-deletion retry and post-token-expiry resweep.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(42);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'd1000000-1000-4000-8000-000000000001'::uuid,
  'delete-resweep@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

select is(
  public.prepare_account_deletion(
    'd1000000-1000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'prepared',
  'account deletion first captures a durable storage manifest'
);

select ok(
  public.is_account_deletion_requested(
    'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'the service upload guard closes as soon as deletion is requested'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'public.account_deletion_jobs',
    'SELECT'
  ),
  'authenticated cannot read deletion jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_account_deletion_initial(text,integer)',
    'EXECUTE'
  ),
  'authenticated cannot claim initial deletion jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_account_deletion_resweep(text,integer)',
    'EXECUTE'
  ),
  'authenticated cannot claim deletion resweeps'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.is_account_deletion_requested(uuid)',
    'EXECUTE'
  ),
  'authenticated cannot probe deletion status directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_account_deletion_initial(text,integer)',
    'EXECUTE'
  ),
  'service role can claim initial deletion jobs'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.transition_account_deletion_initial(uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'service role can transition a leased initial deletion'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_account_deletion_resweep(text,integer)',
    'EXECUTE'
  ),
  'service role can claim deletion resweeps'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.finalize_account_deletion_resweep(uuid,uuid,boolean,text)',
    'EXECUTE'
  ),
  'service role can finalize leased resweeps'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.is_account_deletion_requested(uuid)',
    'EXECUTE'
  ),
  'service role can enforce the deletion upload guard'
);

select is(
  public.claim_account_deletion_initial('deletion-worker-too-early', 300)
    ->> 'status',
  'no_work',
  'the scheduler leaves a fresh request to the route-owned deletion pass'
);

update public.account_deletion_jobs
set updated_at = timezone('utc'::text, now()) - interval '3 minutes'
where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid;

create temporary table initial_deletion_claim as
select public.claim_account_deletion_initial('deletion-worker-a', 300) as payload;

select is(
  (select payload ->> 'status' from initial_deletion_claim),
  'claimed',
  'a worker leases one initial deletion'
);
select is(
  (select payload ->> 'job_status' from initial_deletion_claim),
  'storage_deleting',
  'a new deletion resumes at the storage sweep'
);
select is(
  public.claim_account_deletion_initial('deletion-worker-b', 300) ->> 'status',
  'no_work',
  'a live lease prevents a second initial worker'
);
select is(
  public.transition_account_deletion_initial(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid,
    'storage_deleted',
    null
  ) ->> 'status',
  'lease_mismatch',
  'a stale worker cannot transition an initial deletion'
);
select is(
  public.transition_account_deletion_initial(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from initial_deletion_claim
    ),
    'storage_deleted',
    null
  ) ->> 'status',
  'storage_deleted',
  'the lease owner records the first storage sweep'
);
select is(
  public.transition_account_deletion_initial(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from initial_deletion_claim
    ),
    'auth_deleting',
    null
  ) ->> 'status',
  'auth_deleting',
  'the same lease advances to auth deletion'
);

delete from auth.users
where id = 'd1000000-1000-4000-8000-000000000001'::uuid;

select is(
  (
    select status
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'resweep_waiting',
  'auth deletion schedules a delayed storage resweep'
);
select is(
  public.mark_account_deletion_stage(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    'failed',
    'ambiguous Auth API response'
  ) ->> 'status',
  'resweep_pending',
  'a legacy failure marker cannot overwrite a scheduled resweep'
);
select ok(
  (
    select storage_manifest ? 'user_prefix_buckets'
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'auth deletion preserves the full cleanup manifest'
);
select ok(
  (
    select resweep_after >= auth_delete_started_at + interval '2 hours'
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'the resweep waits beyond the signed-upload token window'
);
select is(
  public.claim_account_deletion_resweep('resweep-worker-early', 300) ->> 'status',
  'no_work',
  'a worker cannot claim the resweep before token expiry'
);

update public.account_deletion_jobs
set resweep_after = timezone('utc'::text, now()) - interval '1 minute',
    next_attempt_at = timezone('utc'::text, now()) - interval '1 minute'
where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid;

create temporary table deletion_resweep_claim as
select public.claim_account_deletion_resweep('resweep-worker-a', 300) as payload;

select is(
  (select payload ->> 'status' from deletion_resweep_claim),
  'claimed',
  'a due resweep can be leased'
);
select is(
  public.finalize_account_deletion_resweep(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid,
    true,
    null
  ) ->> 'status',
  'lease_mismatch',
  'a stale worker cannot finalize a resweep'
);
select is(
  public.finalize_account_deletion_resweep(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from deletion_resweep_claim
    ),
    false,
    'transient storage failure'
  ) ->> 'status',
  'retry_scheduled',
  'a failed resweep is durably rescheduled'
);
select ok(
  (
    select storage_manifest ? 'user_prefix_buckets'
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'a failed resweep retains the cleanup manifest'
);

update public.account_deletion_jobs
set next_attempt_at = timezone('utc'::text, now()) - interval '1 minute'
where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid;

create temporary table deletion_resweep_retry_claim as
select public.claim_account_deletion_resweep('resweep-worker-b', 300) as payload;

select is(
  public.finalize_account_deletion_resweep(
    'd1000000-1000-4000-8000-000000000001'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from deletion_resweep_retry_claim
    ),
    true,
    null
  ) ->> 'status',
  'completed',
  'a successful final resweep completes deletion'
);
select is(
  (
    select status
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'completed',
  'the durable job records completion'
);
select is(
  (
    select count(*)::integer
    from jsonb_object_keys((
      select storage_manifest
      from public.account_deletion_jobs
      where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
    ))
  ),
  1,
  'only final success redacts storage paths from the manifest'
);
select ok(
  (
    select final_resweep_completed_at is not null
    from public.account_deletion_jobs
    where user_id = 'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'final resweep completion is timestamped'
);
select ok(
  public.is_account_deletion_requested(
    'd1000000-1000-4000-8000-000000000001'::uuid
  ),
  'an old signed session stays fail-closed after deletion completes'
);

-- A failed initial worker resumes from the last safe stage and can explicitly
-- schedule the resweep when Auth reports that the user is already absent.
select is(
  public.prepare_account_deletion(
    'd2000000-2000-4000-8000-000000000002'::uuid
  ) ->> 'status',
  'prepared',
  'a deletion job can be prepared after an out-of-band auth removal'
);

update public.account_deletion_jobs
set updated_at = timezone('utc'::text, now()) - interval '3 minutes'
where user_id = 'd2000000-2000-4000-8000-000000000002'::uuid;

create temporary table failed_initial_claim as
select public.claim_account_deletion_initial('deletion-worker-c', 300) as payload;

select is(
  public.transition_account_deletion_initial(
    'd2000000-2000-4000-8000-000000000002'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from failed_initial_claim
    ),
    'failed',
    'transient first sweep failure'
  ) ->> 'status',
  'retry_scheduled',
  'an initial failure releases its lease for retry'
);

update public.account_deletion_jobs
set next_attempt_at = timezone('utc'::text, now()) - interval '1 minute'
where user_id = 'd2000000-2000-4000-8000-000000000002'::uuid;

create temporary table retried_initial_claim as
select public.claim_account_deletion_initial('deletion-worker-d', 300) as payload;

select is(
  (select payload ->> 'job_status' from retried_initial_claim),
  'storage_deleting',
  'a failed first sweep resumes at storage deletion'
);
select is(
  public.transition_account_deletion_initial(
    'd2000000-2000-4000-8000-000000000002'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from retried_initial_claim
    ),
    'storage_deleted',
    null
  ) ->> 'status',
  'storage_deleted',
  'the retry can finish its storage sweep'
);
select is(
  public.transition_account_deletion_initial(
    'd2000000-2000-4000-8000-000000000002'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from retried_initial_claim
    ),
    'auth_deleting',
    null
  ) ->> 'status',
  'auth_deleting',
  'the retry advances to its Auth step'
);
select is(
  public.transition_account_deletion_initial(
    'd2000000-2000-4000-8000-000000000002'::uuid,
    (
      select (payload ->> 'lease_token')::uuid
      from retried_initial_claim
    ),
    'resweep_waiting',
    null
  ) ->> 'status',
  'resweep_pending',
  'an already-missing Auth user still schedules final cleanup'
);
select ok(
  (
    select storage_manifest ? 'user_prefix_buckets'
    from public.account_deletion_jobs
    where user_id = 'd2000000-2000-4000-8000-000000000002'::uuid
  ),
  'the Auth-not-found path preserves its manifest for resweep'
);

select is(
  public.prepare_account_deletion(
    'd3000000-3000-4000-8000-000000000003'::uuid
  ) ->> 'status',
  'prepared',
  'a legacy route fallback job is prepared'
);
select is(
  public.mark_account_deletion_stage(
    'd3000000-3000-4000-8000-000000000003'::uuid,
    'completed',
    null
  ) ->> 'status',
  'resweep_pending',
  'legacy completion schedules rather than skips the final resweep'
);
select ok(
  (
    select status = 'resweep_waiting'
      and storage_manifest ? 'user_prefix_buckets'
    from public.account_deletion_jobs
    where user_id = 'd3000000-3000-4000-8000-000000000003'::uuid
  ),
  'legacy fallback also keeps the full manifest until final success'
);

select * from finish();
rollback;

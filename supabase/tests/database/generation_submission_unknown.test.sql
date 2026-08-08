-- Behavioural coverage for the F14 ambiguous-submission state machine.
--
-- Task creation times out at 30s with no retry, so a timeout is indistinguishable
-- from a definitive provider rejection -- but Kie may have accepted the task.
-- Refunding on the spot loses the money twice: once on the refund, and again on
-- the output the provider bills for and whose callback is then discarded.
--
-- The held row keeps the exact shape both existing recovery paths already match,
-- so what has to be proven here is that neither of them changed behaviour, and
-- that the money-losing residual leaves an artifact.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  '00000000-0000-4000-8000-0000000f1400'::uuid,
  'submission-unknown-test@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

update public.profiles set credits = 100
where id = '00000000-0000-4000-8000-0000000f1400'::uuid;

-- The idempotency hashes matter: `settle_generation_start_failed` clears them so
-- a settled generation can be retried, and the hold must not.
insert into public.generations
  (id, user_id, model, cost, status, prompt, category, client_request_key_hash)
values
  ('f1400000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-0000000f1400'::uuid,
   'nano-banana-pro', 10, 'pending', 'held then rescued', 'image', repeat('a', 64)),
  ('f1400000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-0000000f1400'::uuid,
   'nano-banana-pro', 10, 'pending', 'held then expired', 'image', repeat('b', 64)),
  ('f1400000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-8000-0000000f1400'::uuid,
   'nano-banana-pro', 10, 'pending', 'clean start failure', 'image', repeat('c', 64));

-- ─── Holding does not touch money ────────────────────────────────────────────

select is(
  public.mark_generation_submission_unknown('f1400000-0000-4000-8000-000000000001'::uuid) ->> 'status',
  'held',
  'an ambiguous submission is marked held'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000f1400'::uuid),
  100,
  'holding refunds nothing -- the provider may still deliver'
);

select is(
  (select status from public.generations where id = 'f1400000-0000-4000-8000-000000000001'::uuid),
  'pending',
  'the row keeps the status every other subsystem already matches on'
);

select isnt(
  (select client_request_key_hash from public.generations
   where id = 'f1400000-0000-4000-8000-000000000001'::uuid),
  null,
  'the idempotency key survives, so a same-key resubmit replays instead of charging twice'
);

select is(
  public.mark_generation_submission_unknown('f1400000-0000-4000-8000-000000000001'::uuid) ->> 'status',
  'already_marked',
  'marking twice is idempotent'
);

-- ─── Exit one: the callback lands and rescues the generation ─────────────────

select is(
  public.attach_generation_provider_task(
    'f1400000-0000-4000-8000-000000000001'::uuid, 'kie-task-rescued') ->> 'status',
  'attached',
  'a held row still accepts a provider task -- this is the rescue path'
);

select is(
  (select status from public.generations where id = 'f1400000-0000-4000-8000-000000000001'::uuid),
  'processing',
  'the rescued generation resumes normally'
);

select is(
  public.mark_generation_submission_unknown('f1400000-0000-4000-8000-000000000001'::uuid) ->> 'status',
  'provider_task_attached',
  'a generation the provider already claimed cannot be marked ambiguous'
);

-- ─── Exit two: the grace window expires and the reaper settles ───────────────

select is(
  public.mark_generation_submission_unknown('f1400000-0000-4000-8000-000000000002'::uuid) ->> 'status',
  'held',
  'the second generation is held'
);

select is(
  public.settle_generation_start_failed(
    'f1400000-0000-4000-8000-000000000002'::uuid, 'grace expired') ->> 'status',
  'failed',
  'the existing reaper settlement still owns the refund -- no second timer'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000f1400'::uuid),
  110,
  'the refund lands exactly once, at the reaper window rather than at 30 seconds'
);

select is(
  public.settle_generation_start_failed(
    'f1400000-0000-4000-8000-000000000002'::uuid, 'grace expired') ->> 'submission_unknown',
  'true',
  'the settlement reports that this refund was an ambiguous one'
);

select is(
  public.settle_generation_start_failed(
    'f1400000-0000-4000-8000-000000000003'::uuid, 'rejected') ->> 'submission_unknown',
  'false',
  'a clean start failure is not reported as ambiguous'
);

select isnt(
  (select submission_unknown_at from public.generations
   where id = 'f1400000-0000-4000-8000-000000000002'::uuid),
  null,
  'settlement keeps the marker -- reconciliation keys on it after the fact'
);

select is(
  (select client_request_key_hash from public.generations
   where id = 'f1400000-0000-4000-8000-000000000002'::uuid),
  null,
  'settlement clears the idempotency key, which is exactly what the hold must not do'
);

-- ─── The residual: a callback arriving after the refund ──────────────────────

select is(
  public.record_provider_submission_reconciliation(
    'f1400000-0000-4000-8000-000000000002'::uuid, 'kie-task-late') ->> 'status',
  'recorded',
  'a late callback on a refunded ambiguous submission is recorded for ops'
);

select is(
  public.record_provider_submission_reconciliation(
    'f1400000-0000-4000-8000-000000000002'::uuid, 'kie-task-late') ->> 'status',
  'already_recorded',
  'a retried callback is one discrepancy, not several'
);

select is(
  public.record_provider_submission_reconciliation(
    'f1400000-0000-4000-8000-000000000003'::uuid, 'kie-task-dupe') ->> 'status',
  'not_applicable',
  'an ordinary duplicate callback records nothing -- a ledger of noise is unread'
);

select is(
  (select count(*)::int from public.provider_submission_reconciliations),
  1,
  'exactly one reconciliation row exists, for the generation that lost money'
);

select * from finish();
rollback;

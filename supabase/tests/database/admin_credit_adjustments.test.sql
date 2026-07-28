-- Operator-initiated credit adjustments made from the /admin console.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

-- The two ids must differ in their FIRST 8 hex characters: handle_new_user()
-- derives a username as `creator-<left(uuid without dashes, 8)>`, so ids that
-- share a leading block collide on profiles_username_unique_idx.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  (
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'adjust-subject@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    'a1000002-1000-4000-8000-000000000002'::uuid,
    'adjust-reviewer@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  );

update public.profiles
set credits = 100,
    promotional_credits = 20
where id = 'a1000001-1000-4000-8000-000000000001'::uuid;

-- Access control -----------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.admin_credit_adjustments', 'SELECT'),
  'authenticated cannot read operator credit adjustments'
);
select ok(
  not has_table_privilege('anon', 'public.admin_credit_adjustments', 'SELECT'),
  'anon cannot read operator credit adjustments'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text)',
    'EXECUTE'
  ),
  'authenticated cannot execute the adjustment RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text)',
    'EXECUTE'
  ),
  'service_role can execute the adjustment RPC'
);

-- Goodwill lands in promotional credits ------------------------------------

select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    0,
    500,
    'goodwill after a failed generation',
    'key-goodwill-1'
  ) ->> 'status',
  'applied',
  'a goodwill grant applies'
);

select is(
  (select promotional_credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  520,
  'goodwill increases promotional credits'
);
select is(
  (select credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  100,
  'goodwill leaves purchased credits untouched'
);
select is(
  (select reviewer_id from public.admin_credit_adjustments where idempotency_key = 'key-goodwill-1'),
  'a1000002-1000-4000-8000-000000000002'::uuid,
  'the adjustment records the reviewer who authorised it'
);
select is(
  (select promotional_credits_balance_after from public.admin_credit_adjustments where idempotency_key = 'key-goodwill-1'),
  520,
  'the adjustment snapshots the resulting balance'
);

-- Replaying the same key is idempotent -------------------------------------

select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    0,
    500,
    'goodwill after a failed generation',
    'key-goodwill-1'
  ) ->> 'status',
  'already_applied',
  'replaying an idempotency key reports already_applied'
);
select is(
  (select promotional_credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  520,
  'a replayed adjustment does not credit a second time'
);
select is(
  (select count(*)::integer from public.admin_credit_adjustments where idempotency_key = 'key-goodwill-1'),
  1,
  'a replayed adjustment writes exactly one audit row'
);

-- Refund lands in purchased credits ----------------------------------------

select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    250,
    0,
    'refund for an uncaptured purchase',
    'key-refund-1'
  ) ->> 'status',
  'applied',
  'a refund applies'
);
select is(
  (select credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  350,
  'a refund increases purchased credits'
);
select is(
  (select promotional_credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  520,
  'a refund leaves promotional credits untouched'
);

-- Clawback removes value and may go negative -------------------------------

select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    0,
    -600,
    'clawing back an abusive grant',
    'key-clawback-1'
  ) ->> 'status',
  'applied',
  'a clawback applies'
);
-- Deliberately unclamped, matching the DECISION in
-- 20260725231000_credit_integrity_constraints.sql: clawing back already-spent
-- value must leave a debt rather than silently forgive it.
select is(
  (select promotional_credits from public.profiles where id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  -80,
  'a clawback larger than the balance leaves the account in debt'
);

-- Rejected input ------------------------------------------------------------

select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    0,
    0,
    'no-op',
    'key-noop'
  ) ->> 'status',
  'invalid',
  'an adjustment that moves no balance is rejected'
);
select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    10,
    0,
    '   ',
    'key-blank-reason'
  ) ->> 'status',
  'invalid',
  'an adjustment without a reason is rejected'
);
select is(
  public.apply_admin_credit_adjustment(
    'a1000001-1000-4000-8000-000000000001'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    10,
    0,
    'missing idempotency key',
    '  '
  ) ->> 'status',
  'invalid',
  'an adjustment without an idempotency key is rejected'
);
select is(
  public.apply_admin_credit_adjustment(
    '00000000-0000-4000-8000-00000000dead'::uuid,
    'a1000002-1000-4000-8000-000000000002'::uuid,
    10,
    0,
    'unknown subject',
    'key-missing-user'
  ) ->> 'status',
  'not_found',
  'an adjustment against an unknown user reports not_found'
);
select is(
  (select count(*)::integer from public.admin_credit_adjustments
   where idempotency_key in ('key-noop', 'key-blank-reason', 'key-missing-user')),
  0,
  'rejected adjustments write no audit row'
);

-- The reviewer reference must survive ---------------------------------------

-- ON DELETE RESTRICT: an audit row that no longer names who authorised the
-- change is not an audit row.
select throws_ok(
  $$delete from auth.users where id = 'a1000002-1000-4000-8000-000000000002'::uuid$$,
  '23503',
  null,
  'a reviewer with recorded adjustments cannot be deleted'
);

select is(
  (select count(*)::integer from public.admin_credit_adjustments
   where user_id = 'a1000001-1000-4000-8000-000000000001'::uuid),
  3,
  'every applied adjustment is retained for audit'
);

select * from finish();

rollback;

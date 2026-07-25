-- Behavioural coverage for the payment-to-credit path.
--
-- `add_credits` converts a verified payment into credits. Its load-bearing
-- property is that one transaction can only ever be applied once: a replayed
-- Razorpay webhook, a user-initiated verify, and a reconciliation sweep can all
-- target the same transaction row, and only the first may grant credits.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  '00000000-0000-4000-8000-0000000000c1'::uuid,
  'payment-test@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

update public.profiles set credits = 100
where id = '00000000-0000-4000-8000-0000000000c1'::uuid;

insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values
  ('80000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
   'order_payable', 49900, 500, 'created'),
  ('80000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
   'order_already_success', 49900, 500, 'success'),
  ('80000000-0000-4000-8000-000000000003'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
   'order_mismatch', 49900, 500, 'created');

-- ─── Privilege boundary ──────────────────────────────────────────────────────

select is(
  (
    select procedures.prosecdef
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.add_credits(uuid, integer, uuid, text)'::regprocedure
  ),
  true,
  'the credit grant runs with owner privileges'
);

select is(
  (
    select pg_catalog.has_function_privilege('anon', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.add_credits(uuid, integer, uuid, text)'::regprocedure
  ),
  false,
  'an anonymous client cannot grant itself credits'
);

-- ─── Validation ──────────────────────────────────────────────────────────────

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 500,
    '80000000-0000-4000-8000-0000000000ff'::uuid, 'pay_unknown'
  ),
  false,
  'an unknown transaction grants nothing'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c2'::uuid, 500,
    '80000000-0000-4000-8000-000000000001'::uuid, 'pay_wrong_owner'
  ),
  false,
  'another user cannot claim someone else transaction'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 5000,
    '80000000-0000-4000-8000-000000000003'::uuid, 'pay_mismatch'
  ),
  false,
  'a credit amount that disagrees with the recorded transaction is refused'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 0,
    '80000000-0000-4000-8000-000000000003'::uuid, 'pay_zero'
  ),
  false,
  'a non-positive credit grant is refused'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'::uuid),
  100,
  'no refused grant moved the balance'
);

-- ─── The grant applies exactly once ──────────────────────────────────────────

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 500,
    '80000000-0000-4000-8000-000000000001'::uuid, 'pay_first'
  ),
  true,
  'a created transaction grants its credits'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'::uuid),
  600,
  'the balance reflects the granted credits'
);

select is(
  (select status from public.transactions where id = '80000000-0000-4000-8000-000000000001'::uuid),
  'success',
  'the transaction is marked successful'
);

select is(
  (select credit_effect_applied from public.transactions where id = '80000000-0000-4000-8000-000000000001'::uuid),
  true,
  'the transaction records that its credit effect was applied'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 500,
    '80000000-0000-4000-8000-000000000001'::uuid, 'pay_replay'
  ),
  false,
  'a replayed webhook for the same transaction grants nothing'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'::uuid),
  600,
  'a replayed webhook cannot grant credits twice'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000c1'::uuid, 500,
    '80000000-0000-4000-8000-000000000002'::uuid, 'pay_already_success'
  ),
  false,
  'an already-successful transaction grants nothing'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'::uuid),
  600,
  'an already-successful transaction cannot be re-applied'
);

-- ─── Refund helper ───────────────────────────────────────────────────────────

select lives_ok(
  $$select public.refund_credits('00000000-0000-4000-8000-0000000000c1'::uuid, 50)$$,
  'the refund helper credits an account'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000c1'::uuid),
  650,
  'the refund helper adds exactly the requested amount'
);

select * from finish();
rollback;

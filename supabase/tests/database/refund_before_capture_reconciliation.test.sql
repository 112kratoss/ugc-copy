-- Behavioural coverage for refund reconciliation against the grant state.
--
-- A provider refund/dispute can arrive while its transaction is still
-- 'created' (capture webhook lost or racing). The reconciliation must not
-- debit credits that were never granted, must void the transaction so
-- `add_credits` can no longer grant it, and must keep debiting exactly once
-- for refunds that arrive after the grant.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  '00000000-0000-4000-8000-0000000000d1'::uuid,
  'refund-guard-test@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

update public.profiles set credits = 100
where id = '00000000-0000-4000-8000-0000000000d1'::uuid;

insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values
  ('90000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-0000000000d1'::uuid,
   'order_refund_before_grant', 49900, 500, 'created'),
  ('90000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-0000000000d1'::uuid,
   'order_refund_after_grant', 49900, 500, 'created');

-- ─── Refund before the grant ever applied ────────────────────────────────────

select is(
  public.reconcile_razorpay_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000001'::uuid,
    'evt_before_grant', 'pay_before_grant', 49900, 'reverse', 'payment_refunded'
  ) ->> 'base_credit_delta',
  '0',
  'a refund on an ungranted transaction reports a zero balance delta'
);

select is(
  (
    select razorpay_payment_id
    from public.transactions
    where id = '90000000-0000-4000-8000-000000000001'::uuid
  ),
  'pay_before_grant',
  'refund-before-capture binds provider payment evidence atomically'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  100,
  'a refund before the grant leaves the balance untouched'
);

select is(
  (select status from public.transactions where id = '90000000-0000-4000-8000-000000000001'::uuid),
  'refunded',
  'the ungranted transaction is voided by the refund'
);

select is(
  (select credit_effect_applied from public.transactions where id = '90000000-0000-4000-8000-000000000001'::uuid),
  false,
  'the voided transaction records that no credit effect applied'
);

select is(
  (
    select base_credit_delta from public.credit_purchase_adjustments
    where provider = 'razorpay' and provider_event_id = 'evt_before_grant'
  ),
  0,
  'the adjustment ledger records the reversal with a zero balance delta'
);

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000d1'::uuid, 500,
    '90000000-0000-4000-8000-000000000001'::uuid, 'pay_late_capture'
  ),
  false,
  'a late capture can no longer grant the voided transaction'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  100,
  'the refused late grant moved nothing'
);

-- A provider restore on the voided transaction is bookkeeping-only: nothing
-- was ever granted, so nothing may be credited back and the void must hold.

select is(
  public.reconcile_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000001'::uuid,
    'razorpay', 'evt_void_restore', 0, 'restore', 'dispute_won'
  ) ->> 'base_credit_delta',
  '0',
  'a restore on the voided transaction credits nothing'
);

select is(
  (select status from public.transactions where id = '90000000-0000-4000-8000-000000000001'::uuid),
  'refunded',
  'the voided transaction stays void after a restore'
);

select is(
  public.reconcile_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000001'::uuid,
    'razorpay', 'evt_void_re_reverse', 49900, 'reverse', 'payment_refunded'
  ) ->> 'base_credit_delta',
  '0',
  'a repeated reversal on the voided transaction still debits nothing'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  100,
  'no void-path event ever moved the balance'
);

select is(
  public.reconcile_razorpay_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000002'::uuid,
    'evt_payment_conflict', 'pay_before_grant', 1000, 'reverse', 'payment_refunded'
  ) ->> 'status',
  'payment_conflict',
  'one Razorpay payment cannot be bound to two credit transactions'
);

select is(
  (select status from public.transactions where id = '90000000-0000-4000-8000-000000000002'::uuid),
  'created',
  'a payment binding conflict leaves the second transaction untouched'
);

-- ─── Refund after the grant applied ──────────────────────────────────────────

select is(
  public.add_credits(
    '00000000-0000-4000-8000-0000000000d1'::uuid, 500,
    '90000000-0000-4000-8000-000000000002'::uuid, 'pay_captured'
  ),
  true,
  'the granted transaction applies its credits'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  600,
  'the balance reflects the grant'
);

select is(
  public.reconcile_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000002'::uuid,
    'razorpay', 'evt_after_grant', 49900, 'reverse', 'payment_refunded'
  ) ->> 'base_credit_delta',
  '-500',
  'a refund after the grant debits the granted credits'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  100,
  'the refund after the grant debits exactly once'
);

select is(
  (select status from public.transactions where id = '90000000-0000-4000-8000-000000000002'::uuid),
  'refunded',
  'the granted transaction is marked refunded after full reversal'
);

select is(
  public.reconcile_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000002'::uuid,
    'razorpay', 'evt_after_grant', 49900, 'reverse', 'payment_refunded'
  ) ->> 'status',
  'duplicate_event',
  'a replayed refund event is rejected as a duplicate'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  100,
  'the replayed refund cannot debit twice'
);

-- The grant-applied gate must not break restores for genuinely granted,
-- fully reversed transactions (dispute won after a refund).

select is(
  public.reconcile_credit_purchase_adjustment(
    '90000000-0000-4000-8000-000000000002'::uuid,
    'razorpay', 'evt_dispute_won', 0, 'restore', 'dispute_won'
  ) ->> 'base_credit_delta',
  '500',
  'a restore on a granted, reversed transaction re-credits the balance'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000d1'::uuid),
  600,
  'the restored balance matches the original grant'
);

select is(
  (select status from public.transactions where id = '90000000-0000-4000-8000-000000000002'::uuid),
  'success',
  'the restored transaction is active again'
);

select * from finish();
rollback;

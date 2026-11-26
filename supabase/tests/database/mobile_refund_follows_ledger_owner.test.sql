-- A store refund reverses the purchase it refunds, on the account that received it, whichever app
-- user RevenueCat names on the event (security audit, 2026-11-27).
--
-- RevenueCat moves a receipt to another app user on a restore (its default "transfer" behaviour),
-- and a guest's receipt follows the guest into the account it links to. The refund then arrives
-- under the new app user. Before 20261127* such an event answered `identity_mismatch`, which the
-- webhook acknowledges: the store returned the money and the credits stayed where they were.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

-- A buys; B is an unrelated account; G is a guest that links into account H.
insert into auth.users (id, email, aud, role, is_anonymous, created_at) values
  ('a7f00001-0000-4000-8000-000000000001', 'refund-owner-a@example.invalid', 'authenticated', 'authenticated', false, timezone('utc'::text, now())),
  ('a7f00002-0000-4000-8000-000000000002', 'refund-other-b@example.invalid', 'authenticated', 'authenticated', false, timezone('utc'::text, now())),
  ('a7f00003-0000-4000-8000-000000000003', null, 'authenticated', 'authenticated', true, timezone('utc'::text, now())),
  ('a7f00004-0000-4000-8000-000000000004', 'refund-account-h@example.invalid', 'authenticated', 'authenticated', false, timezone('utc'::text, now()));
update public.profiles set credits = 0, promotional_credits = 0
where id in ('a7f00001-0000-4000-8000-000000000001', 'a7f00002-0000-4000-8000-000000000002',
             'a7f00003-0000-4000-8000-000000000003', 'a7f00004-0000-4000-8000-000000000004');

-- 1. The receipt moved to an unrelated account before the refund.
select is(public.complete_mobile_purchase(
  'a7f00001-0000-4000-8000-000000000001', null, 'magicbooklet.credits.starter', 'app_store',
  'refund_owner_1', 'mobile_app_store_refund_owner_1', 'mobile_app_store_refund_owner_1') ->> 'status',
  'completed', 'A buys a credit pack');
select is((select credits from public.profiles where id = 'a7f00001-0000-4000-8000-000000000001'), 500, 'A holds the pack');

select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_app_store_refund_owner_1', 'a7f00002-0000-4000-8000-000000000002', 'magicbooklet.credits.starter',
  'refund_owner_1_cancel', 2000, 'refund') ->> 'status',
  'refunded', 'a refund RevenueCat names under another app user is applied');
select is((select credits from public.profiles where id = 'a7f00001-0000-4000-8000-000000000001'), 0,
  'the credits come back from A, who received them');
select is((select credits from public.profiles where id = 'a7f00002-0000-4000-8000-000000000002'), 0,
  'the account the event named is not charged');
select is((select status from public.mobile_store_transactions where external_order_id = 'mobile_app_store_refund_owner_1'), 'revoked',
  'the receipt is revoked');
select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_app_store_refund_owner_1', 'a7f00001-0000-4000-8000-000000000001', 'magicbooklet.credits.starter',
  'refund_owner_1_cancel', 2000, 'refund') ->> 'status',
  'duplicate_event', 'the same event under the buyer is a duplicate, never a second reversal');
select is((select credits from public.profiles where id = 'a7f00001-0000-4000-8000-000000000001'), 0, 'reversed once');

select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_app_store_refund_owner_1', 'a7f00002-0000-4000-8000-000000000002', 'magicbooklet.credits.starter',
  'refund_owner_1_reversed', 3000, 'restore') ->> 'status',
  'restored', 'a store reversal of the refund under the other app user is applied too');
select is((select credits from public.profiles where id = 'a7f00001-0000-4000-8000-000000000001'), 500,
  'the pack returns to A');
select is((select credits from public.profiles where id = 'a7f00002-0000-4000-8000-000000000002'), 0,
  'the other app user gains nothing from a receipt it did not pay for');

-- The event must still be about this purchase.
select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_app_store_refund_owner_1', 'a7f00001-0000-4000-8000-000000000001', 'magicbooklet.credits.creator',
  'refund_owner_1_wrong_product', 4000, 'refund') ->> 'status',
  'identity_mismatch', 'an event naming another product for this receipt is refused');
select is((select credits from public.profiles where id = 'a7f00001-0000-4000-8000-000000000001'), 500,
  'and changes nothing');

-- 2. A guest buys, links into an account, and the refund arrives under the account.
select is(public.complete_mobile_purchase(
  'a7f00003-0000-4000-8000-000000000003', null, 'magicbooklet.credits.starter', 'play_store',
  'refund_owner_2', 'mobile_play_store_refund_owner_2', 'mobile_play_store_refund_owner_2') ->> 'status',
  'completed', 'the guest buys a credit pack');
select is(public.merge_guest_account(
  'a7f00003-0000-4000-8000-000000000003', 'a7f00004-0000-4000-8000-000000000004', 'mobile') ->> 'status',
  'merged', 'the guest links into account H');
select is((select credits from public.profiles where id = 'a7f00004-0000-4000-8000-000000000004'), 500,
  'H holds the guest''s pack');

select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_play_store_refund_owner_2', 'a7f00004-0000-4000-8000-000000000004', 'magicbooklet.credits.starter',
  'refund_owner_2_cancel', 2000, 'refund') ->> 'status',
  'refunded', 'a refund RevenueCat names under the linked account is applied');
select is((select credits from public.profiles where id = 'a7f00004-0000-4000-8000-000000000004'), 0,
  'the credits come back from H, where the guest''s balance went');
select is((select credits from public.profiles where id = 'a7f00003-0000-4000-8000-000000000003'), 0,
  'the guest row keeps no balance');

select is(public.reconcile_mobile_purchase_adjustment(
  'mobile_play_store_refund_owner_2', 'a7f00004-0000-4000-8000-000000000004', 'magicbooklet.credits.starter',
  'refund_owner_2_reversed', 3000, 'restore') ->> 'status',
  'restored', 'a store reversal under the linked account is applied');
select is((select credits from public.profiles where id = 'a7f00004-0000-4000-8000-000000000004'), 500,
  'the pack returns to H');

-- Clients still cannot call it.
select ok(not has_function_privilege('authenticated',
  'public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)', 'EXECUTE'),
  'a signed-in client cannot drive a refund');

select * from finish();
rollback;

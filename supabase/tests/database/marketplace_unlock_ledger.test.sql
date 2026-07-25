-- Behavioural coverage for credit-funded marketplace unlocks.
--
-- `unlock_marketplace_asset_with_credits` spends real credits and grants a
-- durable entitlement. Its load-bearing properties are that a buyer is charged
-- at most once per asset, that promotional credits cannot fund a marketplace
-- purchase, and that a seller cannot buy their own listing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('d1000000-0000-4000-8000-000000000001'::uuid, 'unlock-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('d2000000-0000-4000-8000-000000000002'::uuid, 'unlock-seller@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('d3000000-0000-4000-8000-000000000003'::uuid, 'unlock-promo@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles set credits = 1000, promotional_credits = 0
where id = 'd1000000-0000-4000-8000-000000000001'::uuid;

update public.profiles set credits = 1000, promotional_credits = 0
where id = 'd2000000-0000-4000-8000-000000000002'::uuid;

-- Entirely promotional balance: spendable for creation, never for marketplace.
update public.profiles set credits = 900, promotional_credits = 900
where id = 'd3000000-0000-4000-8000-000000000003'::uuid;

insert into public.marketplace_assets (id, seller_user_id, type, title, price_usd_cents, status)
values
  ('90000000-0000-4000-8000-000000000001'::uuid, 'd2000000-0000-4000-8000-000000000002'::uuid,
   'prompt_pack', 'Paid pack', 300, 'active'),
  ('90000000-0000-4000-8000-000000000002'::uuid, 'd2000000-0000-4000-8000-000000000002'::uuid,
   'prompt_pack', 'Free pack', 0, 'active'),
  ('90000000-0000-4000-8000-000000000003'::uuid, 'd2000000-0000-4000-8000-000000000002'::uuid,
   'prompt_pack', 'Draft pack', 300, 'draft');

-- ─── Guards ──────────────────────────────────────────────────────────────────

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-0000000000ff'::uuid
  ) ->> 'status',
  'not_found',
  'an unknown asset cannot be unlocked'
);

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-000000000003'::uuid
  ) ->> 'status',
  'not_found',
  'a draft listing is not purchasable'
);

select is(
  public.unlock_marketplace_asset_with_credits(
    'd2000000-0000-4000-8000-000000000002'::uuid,
    '90000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'owned_by_user',
  'a seller cannot buy their own listing'
);

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-000000000002'::uuid
  ) ->> 'status',
  'not_paid',
  'a free asset is not a credit purchase'
);

select is(
  (select credits from public.profiles where id = 'd1000000-0000-4000-8000-000000000001'::uuid),
  1000,
  'no rejected unlock moved the buyer balance'
);

-- ─── Promotional credits cannot fund a marketplace purchase ──────────────────

select is(
  public.unlock_marketplace_asset_with_credits(
    'd3000000-0000-4000-8000-000000000003'::uuid,
    '90000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'insufficient_credits',
  'an entirely promotional balance cannot fund a marketplace unlock'
);

select is(
  (
    select (public.unlock_marketplace_asset_with_credits(
      'd3000000-0000-4000-8000-000000000003'::uuid,
      '90000000-0000-4000-8000-000000000001'::uuid
    ) ->> 'marketplace_spendable_credits')::integer
  ),
  0,
  'promotional credits report zero marketplace spending power'
);

select is(
  (select credits from public.profiles where id = 'd3000000-0000-4000-8000-000000000003'::uuid),
  900,
  'the refused promotional purchase left the balance intact'
);

-- ─── The purchase charges exactly once ───────────────────────────────────────

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'completed',
  'a funded buyer unlocks the asset'
);

select is(
  (select credits from public.profiles where id = 'd1000000-0000-4000-8000-000000000001'::uuid),
  700,
  'the asset price is deducted once'
);

select is(
  (
    select count(*)::integer from public.marketplace_purchases
    where asset_id = '90000000-0000-4000-8000-000000000001'::uuid
      and buyer_user_id = 'd1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'exactly one entitlement row is created'
);

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'already_owned',
  'a repeated unlock reports the existing entitlement'
);

select is(
  (select credits from public.profiles where id = 'd1000000-0000-4000-8000-000000000001'::uuid),
  700,
  'a repeated unlock never charges the buyer twice'
);

select is(
  (
    select count(*)::integer from public.marketplace_purchases
    where asset_id = '90000000-0000-4000-8000-000000000001'::uuid
      and buyer_user_id = 'd1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'a repeated unlock does not duplicate the entitlement'
);

-- ─── Insufficient funds ──────────────────────────────────────────────────────

update public.profiles set credits = 10, promotional_credits = 0
where id = 'd1000000-0000-4000-8000-000000000001'::uuid;

select is(
  public.unlock_marketplace_asset_with_credits(
    'd1000000-0000-4000-8000-000000000001'::uuid,
    '90000000-0000-4000-8000-000000000002'::uuid
  ) ->> 'status',
  'not_paid',
  'a free asset stays free even when the balance is low'
);

-- ─── Card-funded purchase completion ─────────────────────────────────────────
--
-- `complete_marketplace_purchase` is the Razorpay settlement counterpart to the
-- credit unlock above. Its load-bearing property is that a replayed webhook
-- cannot grant a second entitlement for an order already marked paid.

insert into public.marketplace_orders (asset_id, buyer_user_id, razorpay_order_id, amount_subunits, currency, status)
values
  ('90000000-0000-4000-8000-000000000002'::uuid, 'd1000000-0000-4000-8000-000000000001'::uuid,
   'order_card_pending', 300, 'INR', 'created'),
  ('90000000-0000-4000-8000-000000000002'::uuid, 'd3000000-0000-4000-8000-000000000003'::uuid,
   'order_card_already_paid', 300, 'INR', 'paid');

select is(
  public.complete_marketplace_purchase('order_does_not_exist', 'pay_x'),
  false,
  'an unknown order cannot be completed'
);

select is(
  public.complete_marketplace_purchase('order_card_already_paid', 'pay_replay'),
  false,
  'an order already marked paid refuses a replayed completion'
);

select is(
  public.complete_marketplace_purchase('order_card_pending', 'pay_first'),
  true,
  'a pending order completes'
);

select is(
  (select status from public.marketplace_orders where razorpay_order_id = 'order_card_pending'),
  'paid',
  'the completed order is marked paid'
);

select is(
  (
    select count(*)::integer from public.marketplace_purchases
    where asset_id = '90000000-0000-4000-8000-000000000002'::uuid
      and buyer_user_id = 'd1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'completion grants exactly one entitlement'
);

select is(
  public.complete_marketplace_purchase('order_card_pending', 'pay_replay'),
  false,
  'a replayed webhook for the same order grants nothing further'
);

select is(
  (
    select count(*)::integer from public.marketplace_purchases
    where asset_id = '90000000-0000-4000-8000-000000000002'::uuid
      and buyer_user_id = 'd1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'a replayed webhook does not duplicate the entitlement'
);

select * from finish();
rollback;

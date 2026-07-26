-- Razorpay checkout idempotency and cash entitlement adjustment coverage.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('a1000000-1000-4000-8000-000000000001'::uuid, 'cash-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('a2000000-2000-4000-8000-000000000002'::uuid, 'cash-seller@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

-- ─── Provider order idempotency ──────────────────────────────────────────────

select is(
  public.claim_razorpay_checkout_intent(
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'marketplace',
    'checkout-intent-0001',
    repeat('a', 64)
  ) ->> 'status',
  'claimed',
  'the first checkout caller claims the intent'
);

select matches(
  (
    select provider_receipt
    from public.razorpay_checkout_intents
    where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
      and client_intent_key = 'checkout-intent-0001'
  ),
  '^mb_[0-9a-f]{32}$',
  'the checkout claim owns a stable provider receipt'
);

select is(
  public.claim_razorpay_checkout_intent(
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'marketplace',
    'checkout-intent-0001',
    repeat('a', 64)
  ) ->> 'status',
  'in_progress',
  'a concurrent caller cannot create a second provider order'
);

select is(
  public.claim_razorpay_checkout_intent(
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'marketplace',
    'checkout-intent-0001',
    repeat('b', 64)
  ) ->> 'status',
  'payload_mismatch',
  'an intent key cannot be reused for a different payload'
);

select is(
  public.abandon_razorpay_checkout_intent(
    (
      select id
      from public.razorpay_checkout_intents
      where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
        and client_intent_key = 'checkout-intent-0001'
    ),
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'provider temporarily unavailable'
  ) ->> 'status',
  'abandoned',
  'a failed provider attempt releases the intent for retry'
);

select is(
  public.claim_razorpay_checkout_intent(
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'marketplace',
    'checkout-intent-0001',
    repeat('a', 64)
  ) ->> 'status',
  'claimed',
  'an abandoned intent can be reclaimed'
);

select is(
  (
    select attempt_count
    from public.razorpay_checkout_intents
    where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
      and client_intent_key = 'checkout-intent-0001'
  ),
  2,
  'reclaiming records the second provider attempt'
);

select is(
  public.complete_razorpay_checkout_intent(
    (
      select id
      from public.razorpay_checkout_intents
      where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
        and client_intent_key = 'checkout-intent-0001'
    ),
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'order_provider_001'
  ) ->> 'status',
  'recorded',
  'the claimed intent records its provider order'
);

select is(
  public.complete_razorpay_checkout_intent(
    (
      select id
      from public.razorpay_checkout_intents
      where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
        and client_intent_key = 'checkout-intent-0001'
    ),
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'order_provider_001'
  ) ->> 'status',
  'replay',
  'recording the same provider order is idempotent'
);

select is(
  public.claim_razorpay_checkout_intent(
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'marketplace',
    'checkout-intent-0001',
    repeat('a', 64)
  ) ->> 'provider_order_id',
  'order_provider_001',
  'a replay returns the canonical provider order'
);

select is(
  public.complete_razorpay_checkout_intent(
    (
      select id
      from public.razorpay_checkout_intents
      where user_id = 'a1000000-1000-4000-8000-000000000001'::uuid
        and client_intent_key = 'checkout-intent-0001'
    ),
    'a1000000-1000-4000-8000-000000000001'::uuid,
    'order_provider_conflict'
  ) ->> 'status',
  'provider_order_conflict',
  'an intent cannot be rebound to a different provider order'
);

select throws_ok(
  $$
    select public.claim_razorpay_checkout_intent(
      'a1000000-1000-4000-8000-000000000001'::uuid,
      'marketplace',
      'short',
      repeat('a', 64)
    )
  $$,
  '22023',
  null,
  'invalid client intent keys are rejected in the database'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_razorpay_checkout_intent(uuid,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot call checkout claim RPC directly'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.razorpay_checkout_intents',
    'SELECT'
  ),
  'authenticated cannot query checkout intent records'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_razorpay_checkout_intent(uuid,text,text,text)',
    'EXECUTE'
  ),
  'service role can call checkout claim RPC'
);

insert into public.transactions (
  id,
  user_id,
  razorpay_order_id,
  razorpay_payment_id,
  amount,
  credits,
  status
)
values (
  'a3000000-3000-4000-8000-000000000003'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_credit_cash_1',
  'pay_credit_cash_1',
  9900,
  100,
  'success'
);

select throws_ok(
  $$
    insert into public.transactions (
      user_id,
      razorpay_order_id,
      razorpay_payment_id,
      amount,
      credits,
      status
    ) values (
      'a1000000-1000-4000-8000-000000000001'::uuid,
      'order_credit_duplicate_payment',
      'pay_credit_cash_1',
      9900,
      100,
      'created'
    )
  $$,
  '23505',
  null,
  'one provider payment cannot bind to two credit transactions'
);

-- ─── Marketplace cash refund ─────────────────────────────────────────────────

insert into public.marketplace_assets (
  id,
  seller_user_id,
  type,
  title,
  price_usd_cents,
  status
)
values (
  'b1000000-1000-4000-8000-000000000001'::uuid,
  'a2000000-2000-4000-8000-000000000002'::uuid,
  'prompt_pack',
  'Cash marketplace asset',
  300,
  'active'
);

insert into public.marketplace_orders (
  id,
  asset_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'b2000000-2000-4000-8000-000000000002'::uuid,
  'b1000000-1000-4000-8000-000000000001'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_marketplace_cash_1',
  24900,
  'INR',
  'created'
);

select is(
  public.complete_marketplace_purchase(
    'order_marketplace_cash_1',
    'pay_marketplace_cash_1'
  ),
  true,
  'a captured marketplace order grants its entitlement'
);

select is(
  (
    select sales_count
    from public.marketplace_assets
    where id = 'b1000000-1000-4000-8000-000000000001'::uuid
  ),
  1,
  'marketplace completion increments the seller counter'
);

insert into public.marketplace_orders (
  id,
  asset_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'b2500000-2500-4000-8000-000000000002'::uuid,
  'b1000000-1000-4000-8000-000000000001'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_marketplace_duplicate_checkout',
  24900,
  'INR',
  'created'
);

select is(
  public.complete_marketplace_purchase(
    'order_marketplace_duplicate_checkout',
    'pay_marketplace_duplicate_checkout'
  ),
  false,
  'a second marketplace checkout cannot duplicate an existing entitlement'
);
select is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.marketplace_orders
    where id = 'b2500000-2500-4000-8000-000000000002'::uuid
  ),
  '["failed","pay_marketplace_duplicate_checkout"]'::jsonb,
  'a duplicate marketplace checkout becomes terminal instead of orphan-paid'
);

select is(
  public.reconcile_marketplace_cash_adjustment(
    'event_marketplace_refund_1',
    'pay_marketplace_cash_1',
    'refund',
    'test refund'
  ) ->> 'status',
  'adjusted',
  'a marketplace refund atomically revokes the entitlement'
);

select is(
  (
    select count(*)::integer
    from public.marketplace_purchases
    where order_id = 'b2000000-2000-4000-8000-000000000002'::uuid
  ),
  0,
  'the refunded marketplace entitlement is gone'
);

select is(
  (
    select status
    from public.marketplace_orders
    where id = 'b2000000-2000-4000-8000-000000000002'::uuid
  ),
  'failed',
  'the refunded marketplace order is no longer paid'
);

select is(
  (
    select jsonb_build_array(sales_count, earnings_usd_cents)
    from public.marketplace_assets
    where id = 'b1000000-1000-4000-8000-000000000001'::uuid
  ),
  '[0,0]'::jsonb,
  'marketplace seller counters reverse exactly once'
);

select is(
  public.reconcile_marketplace_cash_adjustment(
    'event_marketplace_refund_1',
    'pay_marketplace_cash_1',
    'refund',
    'same event replay'
  ) ->> 'status',
  'already_adjusted',
  'the same marketplace refund event is idempotent'
);

select is(
  public.reconcile_marketplace_cash_adjustment(
    'event_marketplace_refund_duplicate',
    'pay_marketplace_cash_1',
    'refund',
    'logical replay'
  ) ->> 'status',
  'already_adjusted',
  'a second event cannot repeat the same payment action'
);

select is(
  (
    select count(*)::integer
    from public.cash_purchase_adjustments
    where purchase_kind = 'marketplace'
      and provider_payment_id = 'pay_marketplace_cash_1'
      and action = 'refund'
  ),
  1,
  'exactly one marketplace refund ledger row exists'
);

select is(
  public.reconcile_marketplace_cash_adjustment(
    'event_marketplace_restore_1',
    'pay_marketplace_cash_1',
    'restore',
    'dispute won after irreversible refund'
  ) ->> 'status',
  'manual_review',
  'marketplace restoration is fail-closed for manual review'
);

select is(
  (
    select count(*)::integer
    from public.marketplace_purchases
    where order_id = 'b2000000-2000-4000-8000-000000000002'::uuid
  ),
  0,
  'manual review never silently restores marketplace access'
);

insert into public.marketplace_orders (
  id,
  asset_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'b4000000-4000-4000-8000-000000000004'::uuid,
  'b1000000-1000-4000-8000-000000000001'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_marketplace_refund_before_capture',
  24900,
  'INR',
  'created'
);

select is(
  public.reconcile_marketplace_cash_adjustment(
    'event_marketplace_refund_before_capture',
    'pay_marketplace_refund_before_capture',
    'refund',
    'refund raced ahead of capture',
    'order_marketplace_refund_before_capture'
  ) ->> 'status',
  'adjusted',
  'a marketplace refund before capture is durably applied'
);
select is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.marketplace_orders
    where id = 'b4000000-4000-4000-8000-000000000004'::uuid
  ),
  '["failed","pay_marketplace_refund_before_capture"]'::jsonb,
  'the pre-capture marketplace refund binds the payment and fails the order'
);
select is(
  public.complete_marketplace_purchase(
    'order_marketplace_refund_before_capture',
    'pay_marketplace_refund_before_capture'
  ),
  false,
  'a delayed marketplace capture cannot revive the failed order'
);
select is(
  (
    select count(*)::integer
    from public.marketplace_purchases
    where order_id = 'b4000000-4000-4000-8000-000000000004'::uuid
  ),
  0,
  'the pre-capture marketplace refund never grants an entitlement'
);

select throws_ok(
  $$
    insert into public.marketplace_orders (
      asset_id,
      buyer_user_id,
      razorpay_order_id,
      razorpay_payment_id,
      amount_subunits,
      currency,
      status
    ) values (
      'b1000000-1000-4000-8000-000000000001'::uuid,
      'a1000000-1000-4000-8000-000000000001'::uuid,
      'order_marketplace_duplicate_payment',
      'pay_marketplace_cash_1',
      24900,
      'INR',
      'failed'
    )
  $$,
  '23505',
  null,
  'one provider payment cannot bind to two marketplace orders'
);

-- ─── Post-resource cash refund ────────────────────────────────────────────────

insert into public.posts (
  id,
  user_id,
  visibility,
  category,
  source_kind,
  post_format,
  body
)
values (
  'c1000000-1000-4000-8000-000000000001'::uuid,
  'a2000000-2000-4000-8000-000000000002'::uuid,
  'public',
  'text',
  'external',
  'text',
  'Cash bundle post'
);

insert into public.post_resource_bundles (
  id,
  post_id,
  owner_user_id,
  access_mode,
  status,
  title,
  price_usd_cents,
  prompt_text
)
values (
  'c2000000-2000-4000-8000-000000000002'::uuid,
  'c1000000-1000-4000-8000-000000000001'::uuid,
  'a2000000-2000-4000-8000-000000000002'::uuid,
  'paid',
  'published',
  'Cash resource bundle',
  200,
  'Paid prompt'
);

insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'c3000000-3000-4000-8000-000000000003'::uuid,
  'c2000000-2000-4000-8000-000000000002'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_resource_cash_1',
  19900,
  'INR',
  'created'
);

select is(
  public.complete_post_resource_bundle_purchase(
    'order_resource_cash_1',
    'pay_resource_cash_1'
  ),
  true,
  'a captured resource order grants its entitlement'
);

select is(
  (
    select jsonb_build_array(
      bundles.sales_count,
      wallets.available_token_subunits
    )
    from public.post_resource_bundles bundles
    join public.creator_resource_wallets wallets
      on wallets.user_id = bundles.owner_user_id
    where bundles.id = 'c2000000-2000-4000-8000-000000000002'::uuid
  ),
  '[1,17000]'::jsonb,
  'resource completion settles the creator wallet once'
);

insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'c3500000-3500-4000-8000-000000000003'::uuid,
  'c2000000-2000-4000-8000-000000000002'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_resource_duplicate_checkout',
  19900,
  'INR',
  'created'
);

select is(
  public.complete_post_resource_bundle_purchase(
    'order_resource_duplicate_checkout',
    'pay_resource_duplicate_checkout'
  ),
  false,
  'a second resource checkout cannot duplicate an existing entitlement'
);
select is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.post_resource_bundle_orders
    where id = 'c3500000-3500-4000-8000-000000000003'::uuid
  ),
  '["failed","pay_resource_duplicate_checkout"]'::jsonb,
  'a duplicate resource checkout becomes terminal instead of orphan-paid'
);

select is(
  public.reconcile_post_resource_cash_adjustment(
    'event_resource_refund_1',
    'pay_resource_cash_1',
    'refund',
    'test refund'
  ) ->> 'status',
  'adjusted',
  'a resource refund atomically revokes the entitlement'
);

select is(
  (
    select count(*)::integer
    from public.post_resource_bundle_purchases
    where order_id = 'c3000000-3000-4000-8000-000000000003'::uuid
  ),
  0,
  'the refunded resource entitlement is gone'
);

select is(
  (
    select status
    from public.post_resource_bundle_orders
    where id = 'c3000000-3000-4000-8000-000000000003'::uuid
  ),
  'failed',
  'the refunded resource order is no longer paid'
);

select is(
  (
    select sales_count
    from public.post_resource_bundles
    where id = 'c2000000-2000-4000-8000-000000000002'::uuid
  ),
  0,
  'resource sales_count reverses exactly once'
);

select is(
  (
    select count(*)::integer
    from public.creator_resource_wallet_entries
    where order_id = 'c3000000-3000-4000-8000-000000000003'::uuid
      and entry_kind = 'refund'
  ),
  1,
  'the existing creator ledger records one refund reversal'
);

select is(
  (
    select available_token_subunits
    from public.creator_resource_wallets
    where user_id = 'a2000000-2000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'the resource refund reverses creator available earnings'
);

select is(
  public.reconcile_post_resource_cash_adjustment(
    'event_resource_refund_1',
    'pay_resource_cash_1',
    'refund',
    'same event replay'
  ) ->> 'status',
  'already_adjusted',
  'the same resource refund event is idempotent'
);

select is(
  (
    select count(*)::integer
    from public.cash_purchase_adjustments
    where purchase_kind = 'post_resource'
      and provider_payment_id = 'pay_resource_cash_1'
      and action = 'refund'
  ),
  1,
  'exactly one resource refund ledger row exists'
);

select is(
  public.reconcile_post_resource_cash_adjustment(
    'event_resource_restore_1',
    'pay_resource_cash_1',
    'restore',
    'dispute won'
  ) ->> 'status',
  'manual_review',
  'resource restoration is fail-closed for manual review'
);

insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status
)
values (
  'c4000000-4000-4000-8000-000000000004'::uuid,
  'c2000000-2000-4000-8000-000000000002'::uuid,
  'a1000000-1000-4000-8000-000000000001'::uuid,
  'order_resource_refund_before_capture',
  19900,
  'INR',
  'created'
);

select is(
  public.reconcile_post_resource_cash_adjustment(
    'event_resource_refund_before_capture',
    'pay_resource_refund_before_capture',
    'refund',
    'refund raced ahead of capture',
    'order_resource_refund_before_capture'
  ) ->> 'status',
  'adjusted',
  'a resource refund before capture is durably applied'
);
select is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.post_resource_bundle_orders
    where id = 'c4000000-4000-4000-8000-000000000004'::uuid
  ),
  '["failed","pay_resource_refund_before_capture"]'::jsonb,
  'the pre-capture resource refund binds the payment and fails the order'
);
select is(
  public.complete_post_resource_bundle_purchase(
    'order_resource_refund_before_capture',
    'pay_resource_refund_before_capture'
  ),
  false,
  'a delayed resource capture cannot revive the failed order'
);
select is(
  (
    select count(*)::integer
    from public.post_resource_bundle_purchases
    where order_id = 'c4000000-4000-4000-8000-000000000004'::uuid
  ),
  0,
  'the pre-capture resource refund never grants an entitlement'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.reconcile_marketplace_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot reconcile marketplace cash adjustments'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot reconcile resource cash adjustments'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.reconcile_marketplace_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reconcile marketplace cash adjustments'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reconcile resource cash adjustments'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.cash_purchase_adjustments',
    'SELECT'
  ),
  'authenticated cannot query the cash adjustment ledger'
);

select * from finish();
rollback;

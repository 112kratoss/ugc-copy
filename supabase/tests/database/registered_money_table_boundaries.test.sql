-- Supabase anonymous sign-ins receive the `authenticated` database role. These
-- checks prove that owner policies alone cannot expose financial or paid-
-- marketplace rows to guest identities.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

insert into auth.users (
  id,
  email,
  aud,
  role,
  is_anonymous,
  raw_app_meta_data,
  raw_user_meta_data
) values
  ('a2100001-0000-4000-8000-000000000001'::uuid, null,
   'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb),
  ('a2100002-0000-4000-8000-000000000002'::uuid, 'registered-money@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb),
  ('a2100003-0000-4000-8000-000000000003'::uuid, 'marketplace-seller@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb);

insert into public.transactions (
  id, user_id, razorpay_order_id, amount, credits, status
) values
  ('b2100000-0000-4000-8000-000000000001'::uuid,
   'a2100001-0000-4000-8000-000000000001'::uuid,
   'order_guest_financial_boundary', 100, 1, 'created'),
  ('b2100000-0000-4000-8000-000000000002'::uuid,
   'a2100002-0000-4000-8000-000000000002'::uuid,
   'order_registered_financial_boundary', 100, 1, 'created');

insert into public.creator_resource_wallets (
  user_id, available_token_subunits, lifetime_earned_token_subunits
) values
  ('a2100001-0000-4000-8000-000000000001'::uuid, 100, 100),
  ('a2100002-0000-4000-8000-000000000002'::uuid, 100, 100);

insert into public.creator_resource_wallet_entries (
  event_key,
  user_id,
  entry_kind,
  gross_token_units,
  creator_amount_token_subunits,
  platform_fee_token_subunits
) values
  ('guest-financial-boundary',
   'a2100001-0000-4000-8000-000000000001'::uuid,
   'legacy_sale', 1, 85, 15),
  ('registered-financial-boundary',
   'a2100002-0000-4000-8000-000000000002'::uuid,
   'legacy_sale', 1, 85, 15);

insert into public.creator_payout_requests (
  id, user_id, amount_token_subunits, payout_method, payout_details
) values
  ('c2100000-0000-4000-8000-000000000001'::uuid,
   'a2100001-0000-4000-8000-000000000001'::uuid,
   100, 'test', 'guest boundary fixture'),
  ('c2100000-0000-4000-8000-000000000002'::uuid,
   'a2100002-0000-4000-8000-000000000002'::uuid,
   100, 'test', 'registered boundary fixture');

insert into public.marketplace_assets (
  id, seller_user_id, type, title, price_usd_cents, status
) values (
  'd2100000-0000-4000-8000-000000000001'::uuid,
  'a2100003-0000-4000-8000-000000000003'::uuid,
  'prompt_pack', 'Registered identity boundary fixture', 100, 'active'
);

insert into public.marketplace_orders (
  id, asset_id, buyer_user_id, razorpay_order_id,
  amount_subunits, currency, status
) values
  ('e2100000-0000-4000-8000-000000000001'::uuid,
   'd2100000-0000-4000-8000-000000000001'::uuid,
   'a2100001-0000-4000-8000-000000000001'::uuid,
   'marketplace_guest_financial_boundary', 100, 'USD', 'paid'),
  ('e2100000-0000-4000-8000-000000000002'::uuid,
   'd2100000-0000-4000-8000-000000000001'::uuid,
   'a2100002-0000-4000-8000-000000000002'::uuid,
   'marketplace_registered_financial_boundary', 100, 'USD', 'paid');

insert into public.marketplace_purchases (
  id, asset_id, buyer_user_id, order_id,
  price_usd_cents, amount_subunits, currency
) values
  ('f2100000-0000-4000-8000-000000000001'::uuid,
   'd2100000-0000-4000-8000-000000000001'::uuid,
   'a2100001-0000-4000-8000-000000000001'::uuid,
   'e2100000-0000-4000-8000-000000000001'::uuid,
   100, 100, 'USD'),
  ('f2100000-0000-4000-8000-000000000002'::uuid,
   'd2100000-0000-4000-8000-000000000001'::uuid,
   'a2100002-0000-4000-8000-000000000002'::uuid,
   'e2100000-0000-4000-8000-000000000002'::uuid,
   100, 100, 'USD');

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and policyname = 'registered_identity_only'
      and permissive = 'RESTRICTIVE'
      and roles = array['authenticated']::name[]
  ),
  6::bigint,
  'all six financial tables have the restrictive registered-identity policy'
);

-- `marketplace_orders` and `marketplace_purchases` carry the same restrictive
-- policy, but no Data API session reaches them at all: `20260821110000`
-- revokes every `anon`/`authenticated` privilege on both, so the grant is the
-- outer boundary and the policy only starts mattering if a later migration
-- opens one up. Asserting a row count here would raise `permission denied`
-- rather than prove anything, so assert the boundary that is really in force.
-- Keep these as privilege checks: a row count would also pass against a
-- database still carrying the pre-`20260821110000` legacy grants, which is
-- exactly the drift that migration exists to close.
select is(
  has_table_privilege('authenticated', 'public.marketplace_orders', 'SELECT'),
  false,
  'marketplace orders grant no authenticated read, so no guest session can reach them'
);
select is(
  has_table_privilege('anon', 'public.marketplace_orders', 'SELECT'),
  false,
  'marketplace orders grant no anonymous read'
);
select is(
  has_table_privilege('authenticated', 'public.marketplace_purchases', 'SELECT'),
  false,
  'marketplace purchases grant no authenticated read, so no guest session can reach them'
);
select is(
  has_table_privilege('anon', 'public.marketplace_purchases', 'SELECT'),
  false,
  'marketplace purchases grant no anonymous read'
);

-- A guest has the authenticated database role and owns each fixture row, so
-- the original owner policies would admit these reads without the new gate.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a2100001-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true}',
  true
);

select is(public.current_identity_is_registered(), false,
  'the authoritative auth row identifies an anonymous-authenticated session');
select is((select count(*) from public.transactions), 0::bigint,
  'a guest cannot read its transactions');
select is((select count(*) from public.creator_resource_wallets), 0::bigint,
  'a guest cannot read its creator wallet');
select is((select count(*) from public.creator_resource_wallet_entries), 0::bigint,
  'a guest cannot read its creator wallet entries');
select is((select count(*) from public.creator_payout_requests), 0::bigint,
  'a guest cannot read its payout requests');

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a2100002-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":false}',
  true
);

select is(public.current_identity_is_registered(), true,
  'the authoritative auth row identifies a registered session');
select is((select count(*) from public.transactions), 1::bigint,
  'a registered user retains access to its transactions');
select is((select count(*) from public.creator_resource_wallets), 1::bigint,
  'a registered user retains access to its creator wallet');
select is((select count(*) from public.creator_resource_wallet_entries), 1::bigint,
  'a registered user retains access to its creator wallet entries');
select is((select count(*) from public.creator_payout_requests), 1::bigint,
  'a registered user retains access to its payout requests');

reset role;
set local role service_role;
select is(
  jsonb_build_object(
    'transactions', (select count(*) from public.transactions
      where user_id = 'a2100001-0000-4000-8000-000000000001'::uuid),
    'wallets', (select count(*) from public.creator_resource_wallets
      where user_id = 'a2100001-0000-4000-8000-000000000001'::uuid),
    'wallet_entries', (select count(*) from public.creator_resource_wallet_entries
      where user_id = 'a2100001-0000-4000-8000-000000000001'::uuid),
    'payout_requests', (select count(*) from public.creator_payout_requests
      where user_id = 'a2100001-0000-4000-8000-000000000001'::uuid),
    'marketplace_orders', (select count(*) from public.marketplace_orders
      where buyer_user_id = 'a2100001-0000-4000-8000-000000000001'::uuid),
    'marketplace_purchases', (select count(*) from public.marketplace_purchases
      where buyer_user_id = 'a2100001-0000-4000-8000-000000000001'::uuid)
  ),
  '{"transactions":1,"wallets":1,"wallet_entries":1,"payout_requests":1,"marketplace_orders":1,"marketplace_purchases":1}'::jsonb,
  'the service role retains full access for server-side financial workflows'
);

reset role;

select * from finish();
rollback;

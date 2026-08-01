-- Creator payouts move real money out of the platform, so the properties that
-- matter are the accounting ones: a balance can be requested exactly once, a
-- rejection gives it back, a payout consumes it, and the $100 floor holds.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('c1000000-0000-4000-8000-000000000001'::uuid, 'payout-rich@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 'payout-poor@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('c3000000-0000-4000-8000-000000000003'::uuid, 'payout-operator@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

-- 1,500,000 subunits = 15,000 tokens = $150, comfortably over the floor.
insert into public.creator_resource_wallets (user_id, available_token_subunits, lifetime_earned_token_subunits)
values
  ('c1000000-0000-4000-8000-000000000001'::uuid, 1500000, 1500000),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 999999, 999999)
on conflict (user_id) do update
set available_token_subunits = excluded.available_token_subunits,
    lifetime_earned_token_subunits = excluded.lifetime_earned_token_subunits;

-- 1. One subunit under $100 is still under $100.
select is(
  (select public.request_creator_payout(
    'c2000000-0000-4000-8000-000000000002'::uuid, 'upi', 'creator@upi')->>'status'),
  'below_minimum',
  'a balance below $100 cannot be withdrawn'
);

select is(
  (select available_token_subunits from public.creator_resource_wallets
   where user_id = 'c2000000-0000-4000-8000-000000000002'::uuid),
  999999::bigint,
  'a refused request leaves the balance untouched'
);

-- 2. Payout details are required and bounded.
select is(
  (select public.request_creator_payout(
    'c1000000-0000-4000-8000-000000000001'::uuid, 'upi', ' ')->>'status'),
  'invalid_details',
  'a payout request without destination details is refused'
);

select is(
  (select public.request_creator_payout(
    'c1000000-0000-4000-8000-000000000001'::uuid, '', 'creator@upi')->>'status'),
  'invalid_method',
  'a payout request without a method is refused'
);

-- 3. A valid request moves the whole balance into a hold.
select is(
  (select public.request_creator_payout(
    'c1000000-0000-4000-8000-000000000001'::uuid, 'upi', 'creator@upi')->>'status'),
  'requested',
  'a balance over $100 can be withdrawn'
);

select is(
  (select available_token_subunits from public.creator_resource_wallets
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  0::bigint,
  'the requested balance leaves the available pot'
);

select is(
  (select held_token_subunits from public.creator_resource_wallets
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  1500000::bigint,
  'the requested balance is held against the open request'
);

-- 4. The same balance cannot be requested twice.
select is(
  (select public.request_creator_payout(
    'c1000000-0000-4000-8000-000000000001'::uuid, 'upi', 'creator@upi')->>'status'),
  'already_pending',
  'a second request while one is open is refused'
);

select is(
  (select count(*)::int from public.creator_payout_requests
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the double request created no second row'
);

-- 5. A rejection must explain itself, and gives the money back.
select is(
  (select public.resolve_creator_payout_request(
    (select id from public.creator_payout_requests
     where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'reject', null)->>'status'),
  'reason_required',
  'a rejection without a reason is refused'
);

select is(
  (select public.resolve_creator_payout_request(
    (select id from public.creator_payout_requests
     where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'reject', 'Bank details did not match the account name.')->>'status'),
  'rejected',
  'a rejection with a reason resolves the request'
);

select is(
  (select available_token_subunits from public.creator_resource_wallets
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  1500000::bigint,
  'a rejected payout returns the balance to the creator'
);

select is(
  (select held_token_subunits from public.creator_resource_wallets
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  0::bigint,
  'a rejected payout releases the hold'
);

-- 6. A completed payout consumes the hold rather than returning it.
select is(
  (select public.request_creator_payout(
    'c1000000-0000-4000-8000-000000000001'::uuid, 'upi', 'creator@upi')->>'status'),
  'requested',
  'the creator can request again after a rejection'
);

select is(
  (select public.resolve_creator_payout_request(
    (select id from public.creator_payout_requests
     where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid
       and status = 'requested'),
    'c3000000-0000-4000-8000-000000000003'::uuid,
    'mark_paid', 'Paid via UPI', 'UTR12345')->>'status'),
  'paid',
  'an operator can mark a payout paid'
);

select is(
  (select
     available_token_subunits
     + held_token_subunits
     - lifetime_paid_out_token_subunits
   from public.creator_resource_wallets
   where user_id = 'c1000000-0000-4000-8000-000000000001'::uuid),
  (0 - 1500000)::bigint,
  'a paid payout consumes the hold instead of returning it'
);

select finish();

rollback;

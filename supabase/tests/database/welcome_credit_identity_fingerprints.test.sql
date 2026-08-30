begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

-- The recycling loop this ledger closes: sign up → claim 25 credits → delete
-- account (credit_grants cascades away with auth.users) → sign up again →
-- claim again. The durable record is credit_grant_identity_fingerprints,
-- keyed on app-side HMAC digests of the sign-in identifiers, with no tie to
-- auth.users at all.

-- created_at is explicit: auth.users has no default for it, and the claim RPC
-- reads a NULL created_at as a pre-activation legacy account.
insert into auth.users (
  id,
  email,
  aud,
  role,
  is_anonymous,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data
) values
  ('aa100000-0000-4000-8000-000000000001'::uuid, 'fingerprint-first@example.invalid',
   'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('aa200000-0000-4000-8000-000000000002'::uuid, 'fingerprint-recycled@example.invalid',
   'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('aa300000-0000-4000-8000-000000000003'::uuid, 'fingerprint-fresh@example.invalid',
   'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('aa400000-0000-4000-8000-000000000004'::uuid, 'fingerprint-legacy-call@example.invalid',
   'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('aa500000-0000-4000-8000-000000000005'::uuid, null,
   'authenticated', 'authenticated', true,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

-- The signup trigger created placeholder profiles; give every claimant the
-- completed creator identity the RPC requires — including the guest, so the
-- anonymity assertion below proves precedence rather than a profile failure.
update public.profiles set username = 'fp-first', display_name = 'First Claimer'
  where id = 'aa100000-0000-4000-8000-000000000001'::uuid;
update public.profiles set username = 'fp-recycled', display_name = 'Recycled Claimer'
  where id = 'aa200000-0000-4000-8000-000000000002'::uuid;
update public.profiles set username = 'fp-fresh', display_name = 'Fresh Claimer'
  where id = 'aa300000-0000-4000-8000-000000000003'::uuid;
update public.profiles set username = 'fp-legacy-call', display_name = 'Legacy Caller'
  where id = 'aa400000-0000-4000-8000-000000000004'::uuid;
update public.profiles set username = 'fp-guest', display_name = 'Guest Claimer'
  where id = 'aa500000-0000-4000-8000-000000000005'::uuid;

-- 1-3: a first claim pays out and records its digests in the ledger.
create temporary table first_claim as
select public.claim_credit_grant_program(
  'aa100000-0000-4000-8000-000000000001'::uuid,
  'welcome_credits_v1',
  'web',
  array[repeat('a', 64)]
) as payload;

select is(
  (select payload->>'status' from first_claim),
  'claimed',
  'a registered user with a completed identity claims the welcome credits'
);

select is(
  (select credits from public.profiles where id = 'aa100000-0000-4000-8000-000000000001'::uuid),
  25,
  'the claim pays the program amount into the profile'
);

select is(
  (select recorded_via from public.credit_grant_identity_fingerprints
    where program_key = 'welcome_credits_v1' and fingerprint = repeat('a', 64)),
  'claim',
  'the claim records its identity fingerprint in the durable ledger'
);

-- 4: a live account re-claiming reads its own grant record, not the ledger.
select is(
  (select public.claim_credit_grant_program(
    'aa100000-0000-4000-8000-000000000001'::uuid,
    'welcome_credits_v1',
    'web',
    array[repeat('a', 64)]
  )->>'status'),
  'already_claimed',
  'a repeat claim from the same live account still reads already_claimed'
);

-- 5-7: account deletion erases the grant but not the ledger.
select lives_ok(
  $$delete from auth.users where id = 'aa100000-0000-4000-8000-000000000001'::uuid$$,
  'deleting the auth user succeeds'
);

select is(
  (select count(*) from public.credit_grants
    where user_id = 'aa100000-0000-4000-8000-000000000001'::uuid),
  0::bigint,
  'the credit grant cascades away with the auth user'
);

select is(
  (select count(*) from public.credit_grant_identity_fingerprints
    where program_key = 'welcome_credits_v1' and fingerprint = repeat('a', 64)),
  1::bigint,
  'the identity fingerprint survives the account deletion'
);

-- 8-11: a re-registration carrying any recorded digest is refused unpaid.
create temporary table recycled_claim as
select public.claim_credit_grant_program(
  'aa200000-0000-4000-8000-000000000002'::uuid,
  'welcome_credits_v1',
  'web',
  array[repeat('a', 64), repeat('b', 64)]
) as payload;

select is(
  (select payload->>'status' from recycled_claim),
  'identity_already_claimed',
  'a new account whose identity already claimed is refused'
);

select is(
  (select count(*) from public.credit_grants
    where user_id = 'aa200000-0000-4000-8000-000000000002'::uuid),
  0::bigint,
  'the refused claim writes no grant'
);

select is(
  (select credits from public.profiles where id = 'aa200000-0000-4000-8000-000000000002'::uuid),
  0,
  'the refused claim pays nothing'
);

select is(
  (select count(*) from public.credit_grant_identity_fingerprints
    where fingerprint = repeat('b', 64)),
  0::bigint,
  'a refused claim records none of its own fingerprints'
);

-- 12: an unrelated identity still claims normally.
select is(
  (select public.claim_credit_grant_program(
    'aa300000-0000-4000-8000-000000000003'::uuid,
    'welcome_credits_v1',
    'web',
    array[repeat('c', 64)]
  )->>'status'),
  'claimed',
  'a genuinely new identity claims normally'
);

-- 13: the pre-migration 3-argument call shape keeps working during the
-- deploy window (NULL fingerprints skip the ledger guard).
select is(
  (select public.claim_credit_grant_program(
    'aa400000-0000-4000-8000-000000000004'::uuid,
    'welcome_credits_v1',
    'mobile'
  )->>'status'),
  'claimed',
  'a 3-argument call from pre-deploy code still claims'
);

-- 14: anonymity is still checked before everything the ledger adds.
select is(
  (select public.claim_credit_grant_program(
    'aa500000-0000-4000-8000-000000000005'::uuid,
    'welcome_credits_v1',
    'mobile',
    array[repeat('a', 64)]
  )->>'status'),
  'not_eligible',
  'a guest is refused before the fingerprint guard is consulted'
);

-- 15: the ledger has no foreign key to auth.users — that tie is the bug.
select ok(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.credit_grant_identity_fingerprints'::regclass
      and contype = 'f'
      and confrelid = 'auth.users'::regclass
  ),
  'the fingerprint ledger has no foreign key to auth.users'
);

-- 16-17: append-only even for service_role — the ledger must not forget.
reset role;
set local role service_role;

select throws_ok(
  $$update public.credit_grant_identity_fingerprints set recorded_via = 'backfill'$$,
  '42501',
  null,
  'service_role cannot rewrite the claim ledger'
);

select throws_ok(
  $$delete from public.credit_grant_identity_fingerprints$$,
  '42501',
  null,
  'service_role cannot erase the claim ledger'
);

reset role;

select * from finish();

rollback;

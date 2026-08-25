-- Behavioural coverage for guest checkout and the guest→account link.
--
-- Asserted against real rows and real balances rather than migration text,
-- because the properties that matter here are not textual. The first design of
-- this feature passed a string-based test suite and would still have failed in
-- production the first time a paying guest registered: it reassigned `user_id`
-- on mobile_store_transactions, which an immutability trigger refuses, and the
-- raise would have rolled the transferred credits back with it.
--
-- The invariants below are the ones money depends on:
--   * a guest starts with nothing and cannot generate
--   * financial rows keep their original guest UUID forever
--   * the balance transfers exactly once, however many times it is retried
--   * settlement recorded under a guest UUID reaches the linked account
--   * several guest identities can link to one account

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select is(
  (
    select pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc as procedures
    where procedures.oid = 'public.merge_guest_account(uuid, uuid, text)'::regprocedure
  ),
  false,
  'a signed-in client cannot link accounts directly'
);

select is(
  (
    select pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc as procedures
    where procedures.oid = 'public.redeem_account_merge_ticket(text, uuid, text)'::regprocedure
  ),
  false,
  'a signed-in client cannot redeem a ticket directly'
);

select is(
  (
    select pg_catalog.has_table_privilege('authenticated', 'public.account_merge_tickets', 'SELECT')
  ),
  false,
  'ticket hashes are never readable by clients'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, is_anonymous)
values
  ('a1a1a1a1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('a2a2a2a2-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('b1b1b1b1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.test', '', now(), now(), false),
  ('b2b2b2b2-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@example.test', '', now(), now(), false);

-- ─── A guest arrives with nothing ────────────────────────────────────────────

select is(
  (select credits from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000001'),
  0,
  'a new guest profile starts at zero credits'
);

select is(
  public.start_generation(
    'a1a1a1a1-0000-4000-8000-000000000001',
    1, 'z-image', 'the cheapest thing available', 'image',
    null, null, null, null, null
  ) ->> 'status',
  'insufficient_credits',
  'a guest cannot generate even the cheapest image for free'
);

select is(
  (select count(*) from public.generations where user_id = 'a1a1a1a1-0000-4000-8000-000000000001'),
  0::bigint,
  'a refused generation creates no row'
);

-- Setting a username is not a route to free credits: eligibility reads
-- auth.users.is_anonymous, not the profile a client can write.
update public.profiles
set username = 'looks-real', display_name = 'Looks Real'
where id = 'a1a1a1a1-0000-4000-8000-000000000001';

select is(
  public.claim_credit_grant_program(
    'a1a1a1a1-0000-4000-8000-000000000001', 'welcome_credits_v1', 'mobile'
  ) ->> 'status',
  'not_eligible',
  'a guest cannot claim welcome credits by setting a username'
);

select is(
  (select credits from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000001'),
  0,
  'the refused claim moved no credits'
);

-- ─── A guest who pays ────────────────────────────────────────────────────────

insert into public.mobile_purchase_intents
  (id, user_id, product_id, entitlement_type, amount_subunits, currency, credits, status, expires_at)
values
  ('cccccccc-0000-4000-8000-000000000001', 'a1a1a1a1-0000-4000-8000-000000000001',
   'com.magicbooklet.credits.pro', 'credits', 49900, 'INR', 500, 'pending', now() + interval '1 day');

insert into public.mobile_store_transactions
  (user_id, provider, store_transaction_id, external_order_id, purchase_intent_id,
   entitlement_type, amount_subunits, currency, credits, status, product_id)
values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'app_store', 'txn_guest_pro', 'mobile_order_guest_pro',
   'cccccccc-0000-4000-8000-000000000001', 'credits', 49900, 'INR', 500, 'active',
   'com.magicbooklet.credits.pro');

update public.profiles set credits = 500 where id = 'a1a1a1a1-0000-4000-8000-000000000001';
update public.profiles set credits = 25 where id = 'b1b1b1b1-0000-4000-8000-000000000001';

-- The constraint that decided the whole design.
select throws_ok(
  $$update public.mobile_store_transactions
    set user_id = 'b1b1b1b1-0000-4000-8000-000000000001'
    where store_transaction_id = 'txn_guest_pro'$$,
  'mobile store transaction user identity is immutable',
  'a paid row cannot be reassigned to another user'
);

-- ─── Linking ─────────────────────────────────────────────────────────────────

select is(
  public.merge_guest_account(
    'a1a1a1a1-0000-4000-8000-000000000001',
    'b1b1b1b1-0000-4000-8000-000000000001',
    'mobile'
  ) ->> 'status',
  'merged',
  'a guest links to the account that just registered'
);

select is(
  (select credits from public.profiles where id = 'b1b1b1b1-0000-4000-8000-000000000001'),
  525,
  'the purchased balance lands on the registered account'
);

select is(
  (select credits from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000001'),
  0,
  'the guest row is drained so the credits cannot be spent twice'
);

select is(
  (select user_id from public.mobile_store_transactions where store_transaction_id = 'txn_guest_pro'),
  'a1a1a1a1-0000-4000-8000-000000000001'::uuid,
  'the financial record still names who was actually charged'
);

select is(
  public.canonical_account_id('a1a1a1a1-0000-4000-8000-000000000001'),
  'b1b1b1b1-0000-4000-8000-000000000001'::uuid,
  'the guest UUID resolves to the account that owns it'
);

select is(
  (select count(*) from public.linked_account_ids('b1b1b1b1-0000-4000-8000-000000000001')),
  2::bigint,
  'the registered account acts for itself and its linked guest'
);

-- ─── Exactly once, however many retries ──────────────────────────────────────

select is(
  public.merge_guest_account(
    'a1a1a1a1-0000-4000-8000-000000000001',
    'b1b1b1b1-0000-4000-8000-000000000001',
    'mobile'
  ) ->> 'status',
  'already_merged',
  'a replayed link reports success rather than erroring'
);

select is(
  (select credits from public.profiles where id = 'b1b1b1b1-0000-4000-8000-000000000001'),
  525,
  'a replayed link pays out nothing a second time'
);

select is(
  public.merge_guest_account(
    'a1a1a1a1-0000-4000-8000-000000000001',
    'b2b2b2b2-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'conflict',
  'the same guest cannot be linked to a second account'
);

select is(
  (select credits from public.profiles where id = 'b2b2b2b2-0000-4000-8000-000000000002'),
  0,
  'the losing account of a conflict receives nothing'
);

-- ─── Settlement recorded under a guest UUID ──────────────────────────────────
--
-- These used to go through `refund_credits`, dropped in 20260825140000 as the
-- last unguarded way to mint credits. A raw balance update is the more faithful
-- stand-in anyway: `forward_linked_account_credit_change` is a trigger on
-- `profiles`, so what it must survive is *any* write to the column, whichever of
-- the nineteen credit functions made it.

update public.profiles
set credits = coalesce(credits, 0) + 285
where id = 'a1a1a1a1-0000-4000-8000-000000000001';

select is(
  (select credits from public.profiles where id = 'b1b1b1b1-0000-4000-8000-000000000001'),
  810,
  'a refund against the guest UUID credits the linked account'
);

select is(
  (select credits from public.profiles where id = 'a1a1a1a1-0000-4000-8000-000000000001'),
  0,
  'the refund does not resurrect a balance on the guest row'
);

update public.profiles
set credits = coalesce(credits, 0) - 100
where id = 'a1a1a1a1-0000-4000-8000-000000000001';

select is(
  (select credits from public.profiles where id = 'b1b1b1b1-0000-4000-8000-000000000001'),
  710,
  'a clawback against the guest UUID debits the linked account'
);

-- ─── Several guests, one account ─────────────────────────────────────────────

update public.profiles set credits = 40 where id = 'a2a2a2a2-0000-4000-8000-000000000002';

select is(
  public.merge_guest_account(
    'a2a2a2a2-0000-4000-8000-000000000002',
    'b1b1b1b1-0000-4000-8000-000000000001',
    'mobile'
  ) ->> 'status',
  'merged',
  'a second guest identity links to the same account'
);

select is(
  (select count(*) from public.linked_account_ids('b1b1b1b1-0000-4000-8000-000000000001')),
  3::bigint,
  'reinstalls accumulate as additional linked identities'
);

select is(
  (select credits from public.profiles where id = 'b1b1b1b1-0000-4000-8000-000000000001'),
  750,
  'the second guest balance is added too'
);

-- ─── A registered account is never merged away ───────────────────────────────

select is(
  public.merge_guest_account(
    'b2b2b2b2-0000-4000-8000-000000000002',
    'b1b1b1b1-0000-4000-8000-000000000001',
    'mobile'
  ) ->> 'status',
  'not_eligible',
  'a registered account cannot be absorbed into another'
);

select * from finish();
rollback;

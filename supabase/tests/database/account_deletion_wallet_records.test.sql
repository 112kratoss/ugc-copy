-- The wallet ledger account deletion writes before the Auth cascade.
--
-- Asserted against real rows and grants rather than migration text. The
-- invariants:
--   * no client can read or write it, and the service role can only append
--   * the service role's insert, and its retried insert, work as the code
--     sends them (upsert with ignoreDuplicates is ON CONFLICT DO NOTHING)
--   * a written balance can be neither rewritten nor deleted by that role
--   * the record outlives the Auth user whose wallet cascades away

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select has_table('public', 'account_deletion_wallet_records', 'the wallet ledger has a table');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.account_deletion_wallet_records'::regclass),
  'the wallet ledger has row level security enabled'
);

select ok(
  not has_table_privilege('anon', 'public.account_deletion_wallet_records', 'SELECT, INSERT, UPDATE, DELETE'),
  'anonymous callers hold no privilege on the wallet ledger'
);

select ok(
  not has_table_privilege('authenticated', 'public.account_deletion_wallet_records', 'SELECT, INSERT, UPDATE, DELETE'),
  'a signed-in client holds no privilege on anyone''s wallet record'
);

select ok(
  has_table_privilege('service_role', 'public.account_deletion_wallet_records', 'SELECT')
    and has_table_privilege('service_role', 'public.account_deletion_wallet_records', 'INSERT'),
  'the deletion service can append and read wallet records'
);

select ok(
  not has_table_privilege('service_role', 'public.account_deletion_wallet_records', 'UPDATE'),
  'the ledger is append-only even for the service role'
);

select ok(
  not has_table_privilege('service_role', 'public.account_deletion_wallet_records', 'DELETE'),
  'wallet records cannot be deleted by the code that writes them'
);

select ok(
  not has_table_privilege('service_role', 'public.account_deletion_wallet_records', 'TRUNCATE'),
  'the service role cannot empty the ledger either'
);

select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.account_deletion_wallet_records'::regclass and contype = 'f'),
  0::bigint,
  'no foreign key can cascade a record away with the account it describes'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, is_anonymous)
values
  ('e7a10001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wallet-record-seller@example.test', '', now(), now(), false);

insert into public.creator_resource_wallets (
  user_id,
  available_token_subunits,
  held_token_subunits,
  lifetime_earned_token_subunits,
  lifetime_refunded_token_subunits,
  lifetime_paid_out_token_subunits
) values ('e7a10001-0000-4000-8000-000000000001', 412500, 0, 500000, 87500, 0);

-- ─── The service role appends, once per wallet and job ──────────────────────

set local role service_role;

select lives_ok(
  $$ insert into public.account_deletion_wallet_records (
       user_id, job_id, available_token_subunits, held_token_subunits,
       lifetime_earned_token_subunits, lifetime_refunded_token_subunits, lifetime_paid_out_token_subunits
     ) values (
       'e7a10001-0000-4000-8000-000000000001', 'e7a10001-0000-4000-8000-000000000001',
       412500, 0, 500000, 87500, 0
     )
     on conflict (user_id, job_id) do nothing $$,
  'the service role records a wallet before the Auth delete'
);

select lives_ok(
  $$ insert into public.account_deletion_wallet_records (
       user_id, job_id, available_token_subunits, held_token_subunits,
       lifetime_earned_token_subunits, lifetime_refunded_token_subunits, lifetime_paid_out_token_subunits
     ) values (
       'e7a10001-0000-4000-8000-000000000001', 'e7a10001-0000-4000-8000-000000000001',
       0, 0, 500000, 87500, 0
     )
     on conflict (user_id, job_id) do nothing $$,
  'a retried deletion repeats its write without an error'
);

select throws_ok(
  $$ update public.account_deletion_wallet_records
       set available_token_subunits = 0
     where user_id = 'e7a10001-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'the service role cannot rewrite a recorded balance'
);

select throws_ok(
  $$ delete from public.account_deletion_wallet_records
     where user_id = 'e7a10001-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'the service role cannot delete a recorded balance'
);

reset role;

select is(
  (select count(*) from public.account_deletion_wallet_records
    where user_id = 'e7a10001-0000-4000-8000-000000000001'),
  1::bigint,
  'one wallet and one deletion job leave exactly one record'
);

select is(
  (select available_token_subunits from public.account_deletion_wallet_records
    where user_id = 'e7a10001-0000-4000-8000-000000000001'),
  412500::bigint,
  'the first write stands; the retry does not replace it'
);

-- ─── The record outlives the account ─────────────────────────────────────────

select lives_ok(
  $$ delete from auth.users where id = 'e7a10001-0000-4000-8000-000000000001' $$,
  'deleting the seller''s Auth user is not blocked by the wallet record'
);

select is(
  (select count(*) from public.creator_resource_wallets
    where user_id = 'e7a10001-0000-4000-8000-000000000001'),
  0::bigint,
  'the wallet itself cascades away with the Auth user'
);

select results_eq(
  $$ select job_id, available_token_subunits, held_token_subunits,
            lifetime_earned_token_subunits, lifetime_refunded_token_subunits,
            lifetime_paid_out_token_subunits
     from public.account_deletion_wallet_records
     where user_id = 'e7a10001-0000-4000-8000-000000000001' $$,
  $$ values ('e7a10001-0000-4000-8000-000000000001'::uuid,
             412500::bigint, 0::bigint, 500000::bigint, 87500::bigint, 0::bigint) $$,
  'what the deleted seller was owed survives the account'
);

set local role authenticated;

select throws_ok(
  $$ select count(*) from public.account_deletion_wallet_records $$,
  '42501',
  null,
  'a signed-in client is refused any read of the ledger'
);

reset role;

select * from finish();
rollback;

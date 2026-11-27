-- The composer's create claims (audit 2026-11-27, finding 4): one per account and key, no client
-- access, the service role inserts, reads and deletes, a day's retention, gone with the account.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.post_create_claims'::regclass),
  'post_create_claims has row-level security enabled'
);
select col_is_pk('public', 'post_create_claims', array['user_id', 'idempotency_key'], 'a claim is one per account and key');
select has_index('public', 'post_create_claims', 'post_create_claims_claimed_idx', 'the retention sweep is indexed by time');

select ok(not has_table_privilege('anon', 'public.post_create_claims', 'SELECT'), 'anon cannot read claims');
select ok(not has_table_privilege('authenticated', 'public.post_create_claims', 'SELECT'), 'authenticated cannot read claims');
select ok(not has_table_privilege('authenticated', 'public.post_create_claims', 'INSERT'), 'authenticated cannot take a claim');
select ok(has_table_privilege('service_role', 'public.post_create_claims', 'INSERT'), 'the service role takes claims');
select ok(has_table_privilege('service_role', 'public.post_create_claims', 'DELETE'), 'the service role gives back a claim whose attempt made nothing');
select ok(not has_table_privilege('service_role', 'public.post_create_claims', 'UPDATE'), 'no claim is changed');

-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('cc100000-0000-4000-8000-000000000001'::uuid, 'create-claims@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

insert into public.post_create_claims (user_id, idempotency_key, post_id, claimed_at) values
  ('cc100000-0000-4000-8000-000000000001', '3f0b8d0e-8f5a-4c1e-9d2b-7a6c5e4d3b2a', 'dd100000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('cc100000-0000-4000-8000-000000000001', '3f0b8d0e-8f5a-4c1e-9d2b-7a6c5e4d3b2b', 'dd100000-0000-4000-8000-000000000002', now());

select throws_ok(
  $$insert into public.post_create_claims (user_id, idempotency_key, post_id)
    values ('cc100000-0000-4000-8000-000000000001', '3f0b8d0e-8f5a-4c1e-9d2b-7a6c5e4d3b2b', 'dd100000-0000-4000-8000-000000000003')$$,
  '23505', null, 'a second request with the same key finds the claim taken'
);

select ok(
  not has_function_privilege('authenticated', 'public.prune_post_create_claims(integer)', 'EXECUTE'),
  'authenticated cannot run the prune'
);
select is(public.prune_post_create_claims(5000), 1, 'the prune removes claims older than a day');
select is(
  (select count(*)::int from public.post_create_claims),
  1,
  'a fresh claim stays'
);

delete from auth.users where id = 'cc100000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.post_create_claims),
  0,
  'deleting the account removes its claims'
);

select * from finish();
rollback;

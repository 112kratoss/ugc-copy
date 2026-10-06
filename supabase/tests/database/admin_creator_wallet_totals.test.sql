begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

select ok(to_regprocedure('public.admin_creator_wallet_totals()') is not null, 'wallet totals RPC exists');
select ok(not has_function_privilege('anon','public.admin_creator_wallet_totals()','EXECUTE'), 'anonymous cannot read all-wallet totals');
select ok(not has_function_privilege('authenticated','public.admin_creator_wallet_totals()','EXECUTE'), 'authenticated cannot read all-wallet totals');
select ok(has_function_privilege('service_role','public.admin_creator_wallet_totals()','EXECUTE'), 'service role can read wallet totals');
select is((select provolatile::text from pg_proc where oid='public.admin_creator_wallet_totals()'::regprocedure), 's', 'wallet totals use a stable snapshot');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.admin_creator_wallet_totals()'::regprocedure), 'wallet definer search path is fixed');
set local role anon;
select throws_ok($$select public.admin_creator_wallet_totals()$$, '42501', null, 'anonymous wallet RPC execution is denied');
reset role;
set local role authenticated;
select throws_ok($$select public.admin_creator_wallet_totals()$$, '42501', null, 'authenticated wallet RPC execution is denied');
reset role;

select is(public.admin_creator_wallet_totals(), '{"wallet_count":0,"available_token_subunits":0,"lifetime_earned_token_subunits":0}'::jsonb, 'empty wallets return zero aggregates');
insert into auth.users(id,email,created_at) values
('a0110001-0000-4000-8000-000000000011','wallet-one@audit.invalid',now()),
('a0110002-0000-4000-8000-000000000012','wallet-two@audit.invalid',now()),
('a0110003-0000-4000-8000-000000000013','wallet-zero@audit.invalid',now());
insert into public.creator_resource_wallets(user_id,available_token_subunits,lifetime_earned_token_subunits) values
('a0110001-0000-4000-8000-000000000011',10,10),
('a0110002-0000-4000-8000-000000000012',-4,4),
('a0110003-0000-4000-8000-000000000013',0,0);
select is(public.admin_creator_wallet_totals(), '{"wallet_count":3,"available_token_subunits":6,"lifetime_earned_token_subunits":14}'::jsonb, 'zero wallets count and negative available balance offsets the sum');
set local role service_role;
select is(public.admin_creator_wallet_totals(), '{"wallet_count":3,"available_token_subunits":6,"lifetime_earned_token_subunits":14}'::jsonb, 'authorized API role reads the exact aggregate');
reset role;
select * from finish();
rollback;

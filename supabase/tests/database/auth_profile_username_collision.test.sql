begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

select ok((select prosecdef from pg_proc where oid='public.handle_new_user()'::regprocedure), 'signup trigger remains a definer');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.handle_new_user()'::regprocedure), 'signup search path is fixed');
select ok(not has_function_privilege('anon','public.handle_new_user()','EXECUTE'), 'anonymous trigger execution is revoked');
select ok(not has_function_privilege('authenticated','public.handle_new_user()','EXECUTE'), 'authenticated trigger execution is revoked');
select ok(has_function_privilege('service_role','public.handle_new_user()','EXECUTE'), 'service trigger execution is preserved');
set local role anon;
select throws_ok($$select public.handle_new_user()$$, '42501', null, 'anonymous direct call is denied');
reset role;
set local role authenticated;
select throws_ok($$select public.handle_new_user()$$, '42501', null, 'authenticated direct call is denied');
reset role;

insert into auth.users(id,email,created_at,is_anonymous) values
('a0111100-0000-4000-8000-000000000001','collision-first@audit.invalid',now(),false);
select is((select username from public.profiles where id='a0111100-0000-4000-8000-000000000001'), 'creator-a0111100', 'noncolliding signup keeps its preferred placeholder');
select is((select credits from public.profiles where id='a0111100-0000-4000-8000-000000000001'), 0, 'new signup has no credits');
select lives_ok($$
  insert into auth.users(id,email,created_at,is_anonymous) values
  ('a0111100-0000-4000-8000-000000000002','collision-second@audit.invalid',now(),false),
  ('a0111100-0000-4000-8000-000000000003',null,now(),true);
$$, 'registered and guest identities sharing a UUID prefix are created');
select matches((select username from public.profiles where id='a0111100-0000-4000-8000-000000000002'), '^creator-[a-f0-9]{8}$', 'collision fallback stays a generated placeholder');
select isnt((select username from public.profiles where id='a0111100-0000-4000-8000-000000000002'), 'creator-a0111100', 'collision fallback does not steal the existing name');
select is((select count(*) from public.profiles where id::text like 'a0111100-%' and credits=0 and promotional_credits=0), 3::bigint, 'all colliding identities start with zero credits');
select ok((select is_anonymous from auth.users where id='a0111100-0000-4000-8000-000000000003'), 'guest anonymity is preserved');
update public.profiles set display_name='Collision Fixture' where id::text like 'a0111100-%';
select is(public.claim_credit_grant_program('a0111100-0000-4000-8000-000000000002','welcome_credits_v1','web',array[repeat('1',64)])->>'status', 'not_eligible', 'registered fallback alone cannot claim welcome credits');
select is(public.claim_credit_grant_program('a0111100-0000-4000-8000-000000000003','welcome_credits_v1','web',array[repeat('2',64)])->>'status', 'not_eligible', 'guest fallback cannot claim welcome credits');
select is((select count(*) from public.credit_grants where user_id::text like 'a0111100-%'), 0::bigint, 'no welcome grant was created');

insert into auth.users(id,email,created_at,is_anonymous) values
('a0111101-0000-4000-8000-000000000004','collision-existing-owner@audit.invalid',now(),false);
update public.profiles set username='creator-a0111102' where id='a0111101-0000-4000-8000-000000000004';
select lives_ok($$insert into auth.users(id,email,created_at,is_anonymous) values ('a0111102-0000-4000-8000-000000000005','collision-existing-new@audit.invalid',now(),false)$$, 'another UUID owning the preferred placeholder permits the new signup');
select is((select username from public.profiles where id='a0111101-0000-4000-8000-000000000004'), 'creator-a0111102', 'collision leaves its original owner unchanged');
select is((select count(distinct lower(username)) from public.profiles where id::text like 'a01111%'), 5::bigint, 'all fixture names remain case-insensitively unique');
select throws_ok($$update public.profiles set username='creator-a0111100' where id='a0111102-0000-4000-8000-000000000005'$$, '23505', null, 'the username uniqueness constraint is still enforced');
select is((select count(*) from public.profiles where id::text like 'a01111%' and credits=0 and promotional_credits=0), 5::bigint, 'signup and denied claims leave every fixture balance at zero');

select * from finish();
rollback;

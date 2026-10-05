begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,aud,role,created_at) values
('a9a00000-0000-4000-8000-000000000001','audit-interest-empty@example.invalid','authenticated','authenticated','1900-01-01'),
('a9a10000-0000-4000-8000-000000000002','audit-interest-healthy@example.invalid','authenticated','authenticated','1900-01-01');
-- Audio generations are valid but intentionally map to no feed-interest category.
insert into public.generations(user_id,status,category,model,completed_at,created_at) values
('a9a00000-0000-4000-8000-000000000001','completed','audio','audit-local','1901-01-01 00:00:00Z','1901-01-01 00:00:00Z'),
('a9a10000-0000-4000-8000-000000000002','completed','image','audit-local','1901-01-01 00:00:00Z','1901-01-01 00:00:00Z');
set local role service_role;
select is(public.refresh_user_interest_weights('1901-01-01 00:01:00Z',90,30,1),1,'process the first empty-result user');
select is((select count(*)::int from public.user_interest_weights where user_id='a9a00000-0000-4000-8000-000000000001'::uuid),0,'do not invent interests for an audio-only user');
select is(public.refresh_user_interest_weights('1901-01-01 00:02:00Z',90,30,1),1,'process a bounded second batch');
select is((select count(*)::int from public.user_interest_weights where user_id='a9a10000-0000-4000-8000-000000000002'),2,'reach the image user behind an empty-result user');
select is(public.refresh_user_interest_weights('1901-01-01 00:03:00Z',90,30,1),1,'return to the older empty-result user');
select is(public.refresh_user_interest_weights('1901-01-01 00:04:00Z',90,30,1),1,'revisit the healthy user on a later sweep');
select is((select max(updated_at) from public.user_interest_weights where user_id='a9a10000-0000-4000-8000-000000000002'),'1901-01-01 00:04:00Z'::timestamptz,'healthy weights continue refreshing');
select is((select count(*)::int from public.user_interest_refresh_state where user_id in ('a9a00000-0000-4000-8000-000000000001','a9a10000-0000-4000-8000-000000000002')),2,'record progress for empty and nonempty results');
select throws_ok($$select public.refresh_user_interest_weights(null,90,30,1)$$,'P0001','Interest refresh timestamp is required','reject missing timestamp');
select throws_ok($$select public.refresh_user_interest_weights(now(),90,30,0)$$,'P0001','Interest refresh limit must be between 1 and 5000','preserve batch bounds');
reset role;
select ok((select relrowsecurity from pg_class where oid='public.user_interest_refresh_state'::regclass),'refresh state has RLS');
select ok(not has_table_privilege('anon','public.user_interest_refresh_state','select'),'anonymous cannot read refresh state');
select ok(not has_table_privilege('authenticated','public.user_interest_refresh_state','insert'),'users cannot forge refresh state');
select ok(not has_table_privilege('service_role','public.user_interest_refresh_state','delete'),'service cannot erase progress through direct DELETE');
select ok(has_table_privilege('service_role','public.user_interest_refresh_state','select,insert,update'),'service has only required transition rights');
select ok(not (select prosecdef from pg_proc where oid='public.refresh_user_interest_weights(timestamptz,integer,integer,integer)'::regprocedure),'refresh remains invoker');
-- A failed progress write must roll the rebuilt weights back with it.
create function public.audit_fail_interest_refresh() returns trigger language plpgsql as $$
begin raise exception 'Injected progress persistence failure'; end $$;
create trigger audit_fail_interest_refresh before insert or update on public.user_interest_refresh_state for each row execute function public.audit_fail_interest_refresh();
set local role service_role;
select throws_ok($$select public.refresh_user_interest_weights('1901-01-01 00:05:00Z',90,30,2)$$,'P0001','Injected progress persistence failure','progress and weights are one atomic operation');
select is((select max(updated_at) from public.user_interest_weights where user_id='a9a10000-0000-4000-8000-000000000002'),'1901-01-01 00:04:00Z'::timestamptz,'failed refresh retains previous weights');
reset role;
drop trigger audit_fail_interest_refresh on public.user_interest_refresh_state;
drop function public.audit_fail_interest_refresh();
-- Privacy cleanup cannot leave progress behind after the account is gone.
delete from auth.users where id='a9a00000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.user_interest_refresh_state where user_id='a9a00000-0000-4000-8000-000000000001'),0,'account deletion cascades refresh state');
select * from finish();
rollback;

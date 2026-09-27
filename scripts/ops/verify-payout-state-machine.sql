-- Production payout state-machine probe. All fixtures and transitions roll back.
-- No payment provider calls or external transfers occur.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
create temporary table payout_audit_results(label text, passed boolean) on commit drop;
grant insert,select on payout_audit_results to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql security invoker as $fn$
begin
 if value is distinct from true then raise exception 'Payout audit failed: %',label; end if;
 insert into pg_temp.payout_audit_results values(label,true);
end; $fn$;
create function pg_temp.is(actual anyelement,expected anyelement,label text) returns void language plpgsql security invoker as $fn$
begin perform pg_temp.ok(actual is not distinct from expected,label); end; $fn$;
create function pg_temp.throws_ok(statement text,code text,unused text,label text) returns void language plpgsql security invoker as $fn$
begin
 begin execute statement;
 exception when others then
   if sqlstate=code and (unused is null or sqlerrm=unused) then perform pg_temp.ok(true,label); return; end if;
   raise;
 end;
 raise exception 'Expected denied operation: %',label;
end; $fn$;
set local search_path=public,pg_temp;
grant execute on function pg_temp.ok(boolean,text), pg_temp.is(anyelement,anyelement,text), pg_temp.throws_ok(text,text,text,text) to authenticated,anon,service_role;

insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e8100001-0000-4000-8000-000000000001','payout-audit-0@example.invalid','authenticated','authenticated',false,now());
insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e8100002-0000-4000-8000-000000000002','payout-audit-1@example.invalid','authenticated','authenticated',false,now());
insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e8100003-0000-4000-8000-000000000003','payout-audit-2@example.invalid','authenticated','authenticated',false,now());
insert into public.creator_resource_wallets(user_id,available_token_subunits,lifetime_earned_token_subunits) values('e8100001-0000-4000-8000-000000000001',1500000,1500000),('e8100002-0000-4000-8000-000000000002',999999,999999);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.is((public.request_creator_payout('e8100002-0000-4000-8000-000000000002','upi','audit@example.invalid')->>'status'),'below_minimum','one subunit below minimum rejected');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100002-0000-4000-8000-000000000002'),'[999999,0,0]'::jsonb,'refused request leaves wallet unchanged');
update public.creator_resource_wallets set available_token_subunits=1000000,lifetime_earned_token_subunits=1000000 where user_id='e8100002-0000-4000-8000-000000000002';
select pg_temp.is((public.request_creator_payout('e8100002-0000-4000-8000-000000000002','upi','audit@example.invalid')->>'status'),'requested','exact minimum accepted');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100002-0000-4000-8000-000000000002'),'[0,1000000,0]'::jsonb,'exact minimum moved into hold');
select pg_temp.is((public.request_creator_payout('e8100001-0000-4000-8000-000000000001','upi','audit@example.invalid')->>'status'),'requested','whole available balance requested');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[0,1500000,0]'::jsonb,'request conserves available plus held');
select pg_temp.is((public.request_creator_payout('e8100001-0000-4000-8000-000000000001','upi','audit@example.invalid')->>'status'),'already_pending','duplicate request rejected');
select pg_temp.is((select count(*) from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001'),1::bigint,'one request row despite replay');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='requested'),'e8100003-0000-4000-8000-000000000003',null,null,null)->>'status'),'invalid_action','null action rejected before mutation');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[0,1500000,0]'::jsonb,'null action cannot release held funds');
select pg_temp.is((select status from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001'),'requested','null action cannot finalize payout');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='requested'),'e8100003-0000-4000-8000-000000000003','invalid','Audit rejection',null)->>'status'),'invalid_action','unknown action rejected');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='requested'),'e8100003-0000-4000-8000-000000000003','reject',null,null)->>'status'),'reason_required','rejection requires reason');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[0,1500000,0]'::jsonb,'invalid decisions leave accounting unchanged');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='requested'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)->>'status'),'rejected','rejection releases hold');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[1500000,0,0]'::jsonb,'rejection restores available exactly once');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='rejected'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)->>'status'),'already_resolved','repeated rejection is inert');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='rejected'),'e8100003-0000-4000-8000-000000000003','mark_paid','Audit rejection',null)->>'status'),'already_resolved','rejected request cannot become paid');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[1500000,0,0]'::jsonb,'conflicting replay cannot change wallet');
select pg_temp.is((public.request_creator_payout('e8100001-0000-4000-8000-000000000001','upi','audit@example.invalid')->>'status'),'requested','new payout after rejection');
update public.creator_resource_wallets set available_token_subunits=250000,lifetime_earned_token_subunits=lifetime_earned_token_subunits+250000 where user_id='e8100001-0000-4000-8000-000000000001';
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='requested'),'e8100003-0000-4000-8000-000000000003','mark_paid','Audit rejection','AUDIT-NO-TRANSFER')->>'status'),'paid','paid consumes original hold');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[250000,0,1500000]'::jsonb,'new earnings preserved during payment');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='paid'),'e8100003-0000-4000-8000-000000000003','mark_paid','Audit rejection',null)->>'status'),'already_resolved','payment replay is inert');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='paid'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)->>'status'),'already_resolved','paid request cannot become rejected');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),'[250000,0,1500000]'::jsonb,'resolution replay cannot duplicate money');
select pg_temp.is((select available_token_subunits+held_token_subunits+lifetime_paid_out_token_subunits=lifetime_earned_token_subunits from public.creator_resource_wallets where user_id='e8100001-0000-4000-8000-000000000001'),true,'available plus held plus paid equals earned without refunds');
update public.creator_resource_wallets set available_token_subunits=-300000 where user_id='e8100002-0000-4000-8000-000000000002';
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100002-0000-4000-8000-000000000002' and status='requested'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)->>'status'),'rejected','rejection restores hold against refund debt');
select pg_temp.is((select jsonb_build_array(available_token_subunits,held_token_subunits,lifetime_paid_out_token_subunits) from public.creator_resource_wallets where user_id='e8100002-0000-4000-8000-000000000002'),'[700000,0,0]'::jsonb,'refund debt preserved after released hold');
update public.creator_resource_wallets set available_token_subunits=1000000 where user_id='e8100002-0000-4000-8000-000000000002';
select pg_temp.is((public.request_creator_payout('e8100002-0000-4000-8000-000000000002','upi','audit@example.invalid')->>'status'),'requested','detachment fixture requested');
reset role;
delete from auth.users where id='e8100002-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.is((select count(*) from public.creator_payout_requests where detached_user_id='e8100002-0000-4000-8000-000000000002' and user_id is null and detached_at is not null),2::bigint,'financial records retain detached identity');
select pg_temp.is((public.resolve_creator_payout_request((select id from public.creator_payout_requests where detached_user_id='e8100002-0000-4000-8000-000000000002' and status='requested'),'e8100003-0000-4000-8000-000000000003','mark_paid','Audit rejection','AUDIT-DETACHED-NO-TRANSFER')->>'status'),'paid','detached obligation remains settleable');
select pg_temp.is((select count(*) from public.creator_resource_wallets where user_id='e8100002-0000-4000-8000-000000000002'),0::bigint,'detached settlement does not recreate wallet');
reset role;
set local role anon;
select pg_temp.throws_ok($q$select public.request_creator_payout('e8100001-0000-4000-8000-000000000001','upi','audit@example.invalid')$q$,'42501',null,'anon cannot call privileged payout request');
select pg_temp.throws_ok($q$select public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='paid'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)$q$,'42501',null,'anon cannot call privileged payout resolve');
reset role;
set local role authenticated;
select pg_temp.throws_ok($q$select public.request_creator_payout('e8100001-0000-4000-8000-000000000001','upi','audit@example.invalid')$q$,'42501',null,'authenticated cannot call privileged payout request');
select pg_temp.throws_ok($q$select public.resolve_creator_payout_request((select id from public.creator_payout_requests where user_id='e8100001-0000-4000-8000-000000000001' and status='paid'),'e8100003-0000-4000-8000-000000000003','reject','Audit rejection',null)$q$,'42501',null,'authenticated cannot call privileged payout resolve');
reset role;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) as payout_audit from pg_temp.payout_audit_results;
rollback;

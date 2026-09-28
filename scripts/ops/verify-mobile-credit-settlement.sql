-- Production mobile credit settlement probe. All fixtures and transitions roll back.
-- No payment provider calls occur.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
create temporary table payment_audit_results(label text, passed boolean) on commit drop;
grant insert,select on payment_audit_results to authenticated,anon,service_role;
create function pg_temp.ok(value boolean,label text) returns void language plpgsql security invoker as $fn$
begin
 if value is distinct from true then raise exception 'Payment audit failed: %',label; end if;
 insert into pg_temp.payment_audit_results values(label,true);
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

insert into auth.users(id,email,aud,role,created_at) values
('e85e0001-0000-4000-8000-000000000001','mobile-settlement-audit@example.invalid','authenticated','authenticated',now());
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.is(public.complete_mobile_purchase(
'e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store',
'audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status',
'completed','verified mobile credit purchase completes');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),500,'mobile purchase grants catalog credits');
select pg_temp.is((select status from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1'),'success','mobile credit transaction succeeds');
select pg_temp.is((select credit_effect_applied from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1'),true,'mobile grant marks effect applied');
select pg_temp.is((select credits from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_store_1'),500,'mobile ledger records catalog credit amount');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','already_processed','duplicate mobile sync does not grant again');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),500,'duplicate preserves balance');
select pg_temp.is(public.complete_mobile_purchase('e85e0002-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','transaction_conflict','another user cannot claim verified transaction');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.creator','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','transaction_conflict','same transaction cannot change credit SKU');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','play_store','audit_store_1','mobile_play_store_audit_store_1','mobile_play_store_audit_store_1')->>'status','transaction_conflict','changing provider cannot duplicate store transaction');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'unknown.credit.sku','app_store','audit_unknown','mobile_app_store_audit_unknown','mobile_app_store_audit_unknown')->>'status','product_not_found','unknown product grants nothing');
select pg_temp.is((select count(*) from public.mobile_store_transactions where user_id='e85e0001-0000-4000-8000-000000000001'),1::bigint,'failed claims add no mobile ledger rows');
select pg_temp.is((select count(*) from public.mobile_purchase_intents where user_id='e85e0001-0000-4000-8000-000000000001'),1::bigint,'duplicate claim leaves no orphan auto-intent');
-- Spend some purchased credits before the refund: reversal records debt.
update public.profiles set credits=100 where id='e85e0001-0000-4000-8000-000000000001';
select pg_temp.is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_1',2000,'refund')->>'status','refunded','mobile refund reverses original grant');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),-400,'spent-credit refund retains debt');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','revoked','client sync cannot restore a refunded receipt');
select pg_temp.is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_1',2000,'refund')->>'status','duplicate_event','same refund event is idempotent');
select pg_temp.is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_restore_old',1000,'restore')->>'status','stale_event','older restore cannot undo refund');
select pg_temp.is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_restore_new',3000,'restore')->>'status','restored','new provider restore credits original grant');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),100,'restore does not erase already-spent credits');
select pg_temp.is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_old',2500,'refund')->>'status','stale_event','older refund cannot undo newer restore');
select pg_temp.is((select count(*) from public.credit_purchase_adjustments where transaction_id=(select id from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1')),2::bigint,'exactly one refund and one restore ledger entry');
select pg_temp.is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','play_store','audit_store_2','mobile_play_store_audit_store_2','mobile_play_store_audit_store_2')->>'status','completed','independent Google purchase settles');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),600,'independent purchase adds catalog credits once');
select pg_temp.ok(not has_function_privilege('anon','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'anonymous cannot grant mobile credits');
select pg_temp.ok(not has_function_privilege('authenticated','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'client cannot bypass receipt verification');
select pg_temp.ok(has_function_privilege('service_role','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'verified service can settle mobile purchase');
select pg_temp.throws_ok($q$select public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_payment_reuse','mobile_app_store_audit_payment_reuse','mobile_app_store_audit_store_1')$q$,'23505',null,'payment binding conflict rolls back entire mobile settlement');
select pg_temp.is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),600,'payment conflict cannot increment credits');
select pg_temp.is((select count(*) from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_payment_reuse'),0::bigint,'payment conflict leaves no partial mobile ledger');
select pg_temp.is((select count(*) from public.mobile_purchase_intents where user_id='e85e0001-0000-4000-8000-000000000001'),2::bigint,'failed mobile grant rolls back auto-intent');
reset role;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) as mobile_credit_audit from pg_temp.payment_audit_results;
rollback;

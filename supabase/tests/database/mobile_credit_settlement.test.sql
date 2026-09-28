begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,aud,role,created_at) values
('e85e0001-0000-4000-8000-000000000001','mobile-settlement-audit@example.invalid','authenticated','authenticated',now());
select is(public.complete_mobile_purchase(
'e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store',
'audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status',
'completed','verified mobile credit purchase completes');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),500,'mobile purchase grants catalog credits');
select is((select status from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1'),'success','mobile credit transaction succeeds');
select is((select credit_effect_applied from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1'),true,'mobile grant marks effect applied');
select is((select credits from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_store_1'),500,'mobile ledger records catalog credit amount');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','already_processed','duplicate mobile sync does not grant again');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),500,'duplicate preserves balance');
select is(public.complete_mobile_purchase('e85e0002-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','transaction_conflict','another user cannot claim verified transaction');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.creator','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','transaction_conflict','same transaction cannot change credit SKU');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','play_store','audit_store_1','mobile_play_store_audit_store_1','mobile_play_store_audit_store_1')->>'status','transaction_conflict','changing provider cannot duplicate store transaction');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'unknown.credit.sku','app_store','audit_unknown','mobile_app_store_audit_unknown','mobile_app_store_audit_unknown')->>'status','product_not_found','unknown product grants nothing');
select is((select count(*) from public.mobile_store_transactions where user_id='e85e0001-0000-4000-8000-000000000001'),1::bigint,'failed claims add no mobile ledger rows');
select is((select count(*) from public.mobile_purchase_intents where user_id='e85e0001-0000-4000-8000-000000000001'),1::bigint,'duplicate claim leaves no orphan auto-intent');
-- Spend some purchased credits before the refund: reversal records debt.
update public.profiles set credits=100 where id='e85e0001-0000-4000-8000-000000000001';
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_1',2000,'refund')->>'status','refunded','mobile refund reverses original grant');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),-400,'spent-credit refund retains debt');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_store_1','mobile_app_store_audit_store_1','mobile_app_store_audit_store_1')->>'status','revoked','client sync cannot restore a refunded receipt');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_1',2000,'refund')->>'status','duplicate_event','same refund event is idempotent');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_restore_old',1000,'restore')->>'status','stale_event','older restore cannot undo refund');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_restore_new',3000,'restore')->>'status','restored','new provider restore credits original grant');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),100,'restore does not erase already-spent credits');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_store_1','e85e0001-0000-4000-8000-000000000001','magicbooklet.credits.starter','mobile_refund_old',2500,'refund')->>'status','stale_event','older refund cannot undo newer restore');
select is((select count(*) from public.credit_purchase_adjustments where transaction_id=(select id from public.transactions where razorpay_order_id='mobile_app_store_audit_store_1')),2::bigint,'exactly one refund and one restore ledger entry');
select is(public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','play_store','audit_store_2','mobile_play_store_audit_store_2','mobile_play_store_audit_store_2')->>'status','completed','independent Google purchase settles');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),600,'independent purchase adds catalog credits once');
select ok(not has_function_privilege('anon','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'anonymous cannot grant mobile credits');
select ok(not has_function_privilege('authenticated','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'client cannot bypass receipt verification');
select ok(has_function_privilege('service_role','public.complete_mobile_purchase(uuid,uuid,text,text,text,text,text,numeric,text)','EXECUTE'),'verified service can settle mobile purchase');
select throws_ok($q$select public.complete_mobile_purchase('e85e0001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_payment_reuse','mobile_app_store_audit_payment_reuse','mobile_app_store_audit_store_1')$q$,'23505',null,'payment binding conflict rolls back entire mobile settlement');
select is((select credits from public.profiles where id='e85e0001-0000-4000-8000-000000000001'),600,'payment conflict cannot increment credits');
select is((select count(*) from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_payment_reuse'),0::bigint,'payment conflict leaves no partial mobile ledger');
select is((select count(*) from public.mobile_purchase_intents where user_id='e85e0001-0000-4000-8000-000000000001'),2::bigint,'failed mobile grant rolls back auto-intent');
select * from finish();
rollback;

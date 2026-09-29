-- Real mobile settlement/refund/restore lifecycle; all fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
create function pg_temp.buy_mobile(buyer uuid, kind text, resource uuid, store_id text) returns jsonb
language plpgsql as $$
declare intent jsonb;
begin
 intent := public.create_mobile_purchase_intent(buyer,kind,resource);
 if intent->>'status' <> 'created' then raise exception 'Fixture intent failed: %',intent; end if;
 return public.complete_mobile_purchase(buyer,(intent->>'purchase_intent_id')::uuid,intent->>'product_id','app_store',store_id,'mobile_app_store_'||store_id,'mobile_app_store_'||store_id);
end; $$;

insert into auth.users(id,email,aud,role,created_at) values ('e85f0001-0000-4000-8000-000000000001','life-buyer-1@example.invalid','authenticated','authenticated',now()),('e85f0002-0000-4000-8000-000000000001','life-seller-1@example.invalid','authenticated','authenticated',now());
insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status) values ('e85f0003-0000-4000-8000-000000000001','e85f0002-0000-4000-8000-000000000001','prompt_pack','Lifecycle fixture',300,'active');
select is(public.provision_mobile_store_product('audit.mobile.lifecycle.1','marketplace_unlock',300,'USD')->>'status','provisioned','marketplace_unlock: fixture catalog provisioned');
select is(pg_temp.buy_mobile('e85f0001-0000-4000-8000-000000000001','marketplace_unlock','e85f0003-0000-4000-8000-000000000001','audit_lifecycle_1_old')->>'status','completed','marketplace_unlock: original purchase settles');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_old','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_refund_old',1000,'refund')->>'status','refunded','marketplace_unlock: original refund completes');
select is(pg_temp.buy_mobile('e85f0001-0000-4000-8000-000000000001','marketplace_unlock','e85f0003-0000-4000-8000-000000000001','audit_lifecycle_1_new')->>'status','completed','marketplace_unlock: repurchase settles');
select throws_ok($q$select public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_old','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_restore_old',2000,'restore')$q$,'P0001','Mobile restoration conflicts with another purchase','marketplace_unlock: conflicting restore is retryable and atomic');
select is((select count(*) from public.mobile_purchase_adjustment_events where provider_event_id='audit_lifecycle_1_restore_old'),0::bigint,'failed restore does not reserve event history');
select is((select status from public.marketplace_orders where razorpay_order_id='mobile_app_store_audit_lifecycle_1_old'),'failed','marketplace_unlock: conflict cannot create an orphan paid order');
select is((select status from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_lifecycle_1_old'),'revoked','marketplace_unlock: conflict cannot activate old ledger');
select is((select provider_event_id from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_lifecycle_1_old'),'audit_lifecycle_1_refund_old','marketplace_unlock: failed restore does not consume event');
select is((select status from public.mobile_purchase_intents where id=(select purchase_intent_id from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_lifecycle_1_old')),'revoked','marketplace_unlock: conflict preserves revoked intent');
select is((select razorpay_order_id from public.marketplace_orders where id=(select order_id from public.marketplace_purchases where buyer_user_id='e85f0001-0000-4000-8000-000000000001')),'mobile_app_store_audit_lifecycle_1_new','marketplace_unlock: new purchase retains entitlement');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85f0002-0000-4000-8000-000000000001'),25500::bigint,'marketplace_unlock: conflict preserves one creator share');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_new','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_refund_new',3000,'refund')->>'status','refunded','marketplace_unlock: new purchase refund completes');
select is((select count(*) from public.marketplace_orders where buyer_user_id='e85f0001-0000-4000-8000-000000000001' and status='paid'),0::bigint,'marketplace_unlock: no paid order without entitlement after second refund');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85f0002-0000-4000-8000-000000000001'),0::bigint,'marketplace_unlock: both refunds reverse creator shares');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_old','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_restore_old',2000,'restore')->>'status','restored','marketplace_unlock: same restore event succeeds after conflict clears');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_old','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_restore_old',2000,'restore')->>'status','duplicate_event','marketplace_unlock: restore event replay is idempotent');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_lifecycle_1_old','e85f0001-0000-4000-8000-000000000001','audit.mobile.lifecycle.1','audit_lifecycle_1_restore_again',4000,'restore')->>'status','already_active','marketplace_unlock: new restore event on same order is idempotent');
select is((select count(*) from public.marketplace_purchases where buyer_user_id='e85f0001-0000-4000-8000-000000000001'),1::bigint,'marketplace_unlock: one restored entitlement');
select is((select razorpay_order_id from public.marketplace_orders where id=(select order_id from public.marketplace_purchases where buyer_user_id='e85f0001-0000-4000-8000-000000000001')),'mobile_app_store_audit_lifecycle_1_old','marketplace_unlock: restoration binds original order');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85f0002-0000-4000-8000-000000000001'),25500::bigint,'marketplace_unlock: restoration credits creator once');


insert into auth.users(id,email,aud,role,created_at) values ('e85f0011-0000-4000-8000-000000000002','life-buyer-2@example.invalid','authenticated','authenticated',now()),('e85f0012-0000-4000-8000-000000000002','life-seller-2@example.invalid','authenticated','authenticated',now());
insert into public.posts(id,user_id,visibility,category,source_kind,post_format,body) values ('e85f0013-0000-4000-8000-000000000002','e85f0012-0000-4000-8000-000000000002','public','text','external','text','Lifecycle fixture');
insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,prompt_text) values ('e85f0014-0000-4000-8000-000000000002','e85f0013-0000-4000-8000-000000000002','e85f0012-0000-4000-8000-000000000002','paid','published','Lifecycle fixture',300,'Paid fixture');
select is(public.provision_mobile_store_product('audit.mobile.lifecycle.2','post_resource_unlock',300,'USD')->>'status','provisioned','post_resource_unlock: fixture catalog provisioned');
select throws_ok($q$select pg_temp.buy_mobile('e85f0011-0000-4000-8000-000000000002','post_resource_unlock','e85f0013-0000-4000-8000-000000000002','audit_lifecycle_2_blocked')$q$,'P0001','Post resource packages are credit-only on mobile','bundle IAP intent remains blocked by credit-only policy');
select is((select count(*) from public.mobile_purchase_intents where user_id='e85f0011-0000-4000-8000-000000000002'),0::bigint,'blocked bundle intent leaves no partial record');
select ok(not has_function_privilege('anon','public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)','EXECUTE'),'anonymous cannot reconcile mobile purchases');
select ok(not has_function_privilege('authenticated','public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)','EXECUTE'),'client cannot bypass verified webhook reconciliation');
select ok(has_function_privilege('service_role','public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)','EXECUTE'),'verified service can reconcile mobile purchases');
select * from finish();
rollback;

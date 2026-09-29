-- Real reconciliation with marketplace purchases and legacy bundle receipts.
-- New bundle IAPs remain disabled; only fixture construction bypasses that policy.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
insert into auth.users(id,email,aud,role,created_at) values
('e85b1001-0000-4000-8000-000000000001','event-buyer@example.invalid','authenticated','authenticated',now()),
('e85b1002-0000-4000-8000-000000000001','event-seller@example.invalid','authenticated','authenticated',now());
create function pg_temp.fixture_receipt(kind text, suffix text) returns void language plpgsql as $$
declare resource uuid:=gen_random_uuid(); bundle uuid:=gen_random_uuid(); intent uuid:=gen_random_uuid(); ord uuid:=gen_random_uuid();
begin
  insert into public.posts(id,user_id,visibility,category,source_kind,post_format,body) values(resource,'e85b1002-0000-4000-8000-000000000001','public','text','external','text','Legacy event fixture');
  insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,prompt_text) values(bundle,resource,'e85b1002-0000-4000-8000-000000000001','paid','published','Legacy fixture',300,'Paid fixture');
  insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status) values(ord,bundle,'e85b1001-0000-4000-8000-000000000001','mobile_app_store_'||suffix,300,'USD','paid');
  insert into public.post_resource_bundle_purchases(bundle_id,buyer_user_id,order_id,price_usd_cents,amount_subunits,currency) values(bundle,'e85b1001-0000-4000-8000-000000000001',ord,300,300,'USD');
  insert into public.mobile_purchase_intents(id,user_id,product_id,entitlement_type,resource_id,amount_subunits,currency,status) values(intent,'e85b1001-0000-4000-8000-000000000001','audit.event.'||kind,kind,resource,300,'USD','consumed');
  insert into public.mobile_store_transactions(provider,store_transaction_id,external_order_id,user_id,product_id,purchase_intent_id,entitlement_type,resource_id,amount_subunits,currency,source_record_id) values('app_store',suffix,'mobile_app_store_'||suffix,'e85b1001-0000-4000-8000-000000000001','audit.event.'||kind,intent,kind,resource,300,'USD',ord);
end; $$;
-- Construct one historical receipt locally; production bundle-IAP policy stays enabled.
alter table public.mobile_purchase_intents disable trigger mobile_post_resources_credit_only;
select pg_temp.fixture_receipt('post_resource_unlock','audit_5k_bundle');
alter table public.mobile_purchase_intents enable trigger mobile_post_resources_credit_only;
-- The legacy fixture models the counters maintained by settlement.
update public.post_resource_bundles set sales_count=1, earnings_usd_cents=300
where owner_user_id='e85b1002-0000-4000-8000-000000000001';
update public.profiles set credits=1000,promotional_credits=0
where id='e85b1001-0000-4000-8000-000000000001';
set local role service_role;
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5k_bundle','e85b1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5k_refund',1000,'refund')->>'status','refunded','legacy refund removes access');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85b1002-0000-4000-8000-000000000001'),0::bigint,'refund reverses original creator share');
savepoint before_credit_repurchase;
select is(public.unlock_post_resource_bundle_with_credits('e85b1001-0000-4000-8000-000000000001',(select resource_id from public.mobile_store_transactions where store_transaction_id='audit_5k_bundle'))->>'status','completed','supported credit purchase grants replacement access');
select throws_ok($q$select public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5k_bundle','e85b1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5k_restore',2000,'restore')$q$,'P0001','Mobile restoration conflicts with another purchase','legacy restore cannot claim a credit-funded entitlement');
select is((select status from public.post_resource_bundle_orders where razorpay_order_id='mobile_app_store_audit_5k_bundle'),'failed','conflict preserves failed legacy order');
select is((select status from public.mobile_store_transactions where store_transaction_id='audit_5k_bundle'),'revoked','conflict preserves revoked receipt');
select is((select provider_event_id from public.mobile_store_transactions where store_transaction_id='audit_5k_bundle'),'audit_5k_refund','conflict does not consume receipt event');
select is((select status from public.mobile_purchase_intents where id=(select purchase_intent_id from public.mobile_store_transactions where store_transaction_id='audit_5k_bundle')),'revoked','conflict preserves revoked intent');
select is((select count(*) from public.mobile_purchase_adjustment_events where provider_event_id='audit_5k_restore'),0::bigint,'conflict does not reserve event history');
select is((select count(*) from public.post_resource_bundle_purchases p join public.post_resource_bundle_orders o on o.id=p.order_id where p.buyer_user_id='e85b1001-0000-4000-8000-000000000001' and o.razorpay_order_id like 'credit_%'),1::bigint,'credit-funded entitlement remains owned by its order');
select is((select credits from public.profiles where id='e85b1001-0000-4000-8000-000000000001'),700,'conflict does not change buyer credits');
select is((select sales_count from public.post_resource_bundles where owner_user_id='e85b1002-0000-4000-8000-000000000001'),1,'conflict preserves one sale');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85b1002-0000-4000-8000-000000000001'),25500::bigint,'conflict preserves one creator share');
-- Roll back only the competing purchase to exercise retry with the same event.
rollback to savepoint before_credit_repurchase;
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5k_bundle','e85b1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5k_restore',2000,'restore')->>'status','restored','same restore event succeeds when conflict is absent');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5k_bundle','e85b1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5k_restore',2000,'restore')->>'status','duplicate_event','successful restore replay is harmless');
select is(public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5k_bundle','e85b1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5k_restore_again',3000,'restore')->>'status','already_active','new restore event on same order is harmless');
select is((select count(*) from public.post_resource_bundle_purchases p join public.post_resource_bundle_orders o on o.id=p.order_id where p.buyer_user_id='e85b1001-0000-4000-8000-000000000001' and o.razorpay_order_id='mobile_app_store_audit_5k_bundle'),1::bigint,'restored access belongs to original order');
select is((select available_token_subunits from public.creator_resource_wallets where user_id='e85b1002-0000-4000-8000-000000000001'),25500::bigint,'restoration credits creator exactly once');
select is((select sales_count from public.post_resource_bundles where owner_user_id='e85b1002-0000-4000-8000-000000000001'),1,'restoration counts one sale');
select * from finish();
rollback;

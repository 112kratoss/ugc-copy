-- Real reconciliation with marketplace purchases and legacy bundle receipts.
-- New bundle IAPs remain disabled; only fixture construction bypasses that policy.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
create function pg_temp.probe_status(statement text) returns text language plpgsql as $$
declare result text;
begin
 begin
  execute 'select '||statement into result;
  raise exception using errcode='Z0001',message='rollback probe';
 exception when sqlstate 'Z0001' then return result; end;
end; $$;
insert into auth.users(id,email,aud,role,created_at) values
('e85a1001-0000-4000-8000-000000000001','event-buyer@example.invalid','authenticated','authenticated',now()),
('e85a1002-0000-4000-8000-000000000001','event-seller@example.invalid','authenticated','authenticated',now());
create function pg_temp.fixture_receipt(kind text, suffix text) returns void language plpgsql as $$
declare resource uuid:=gen_random_uuid(); bundle uuid:=gen_random_uuid(); intent uuid:=gen_random_uuid(); ord uuid:=gen_random_uuid(); purchase jsonb;
begin
 if kind='marketplace_unlock' then
  insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status) values(resource,'e85a1002-0000-4000-8000-000000000001','prompt_pack','Event fixture',300,'active');
  purchase:=public.create_mobile_purchase_intent('e85a1001-0000-4000-8000-000000000001',kind,resource);
  purchase:=public.complete_mobile_purchase('e85a1001-0000-4000-8000-000000000001',(purchase->>'purchase_intent_id')::uuid,purchase->>'product_id','app_store',suffix,'mobile_app_store_'||suffix,'mobile_app_store_'||suffix);
  if purchase->>'status'<>'completed' then raise exception 'Fixture failed: %',purchase; end if;
 else
  insert into public.posts(id,user_id,visibility,category,source_kind,post_format,body) values(resource,'e85a1002-0000-4000-8000-000000000001','public','text','external','text','Legacy event fixture');
  insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,prompt_text) values(bundle,resource,'e85a1002-0000-4000-8000-000000000001','paid','published','Legacy fixture',300,'Paid fixture');
  insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status) values(ord,bundle,'e85a1001-0000-4000-8000-000000000001','mobile_app_store_'||suffix,300,'USD','paid');
  insert into public.post_resource_bundle_purchases(bundle_id,buyer_user_id,order_id,price_usd_cents,amount_subunits,currency) values(bundle,'e85a1001-0000-4000-8000-000000000001',ord,300,300,'USD');
  insert into public.mobile_purchase_intents(id,user_id,product_id,entitlement_type,resource_id,amount_subunits,currency,status) values(intent,'e85a1001-0000-4000-8000-000000000001','audit.event.'||kind,kind,resource,300,'USD','consumed');
  insert into public.mobile_store_transactions(provider,store_transaction_id,external_order_id,user_id,product_id,purchase_intent_id,entitlement_type,resource_id,amount_subunits,currency,source_record_id) values('app_store',suffix,'mobile_app_store_'||suffix,'e85a1001-0000-4000-8000-000000000001','audit.event.'||kind,intent,kind,resource,300,'USD',ord);
 end if;
end; $$;
select public.provision_mobile_store_product('audit.event.marketplace_unlock','marketplace_unlock',300,'USD');
select pg_temp.fixture_receipt('marketplace_unlock','audit_5j_market_1');
select pg_temp.fixture_receipt('marketplace_unlock','audit_5j_market_2');
-- Local legacy-fixture construction only; restore the policy before reconciliation.
alter table public.mobile_purchase_intents disable trigger mobile_post_resources_credit_only;
select pg_temp.fixture_receipt('post_resource_unlock','audit_5j_bundle_1');
select pg_temp.fixture_receipt('post_resource_unlock','audit_5j_bundle_2');
alter table public.mobile_purchase_intents enable trigger mobile_post_resources_credit_only;
select public.complete_mobile_purchase('e85a1001-0000-4000-8000-000000000001',null,'magicbooklet.credits.starter','app_store','audit_5j_credit','mobile_app_store_audit_5j_credit','mobile_app_store_audit_5j_credit');
grant execute on function pg_temp.probe_status(text) to service_role;
set local role service_role;
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',1000,'refund')->>'status'),'refunded','market: refund applies');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',1000,'restore')->>'status'$probe$)),'event_conflict','market: same event cannot change action');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',2000,'refund')->>'status'$probe$)),'event_conflict','market: same event cannot change timestamp');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_2','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',1000,'refund')->>'status'$probe$)),'event_conflict','market: same event cannot revoke another receipt');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_credit','e85a1001-0000-4000-8000-000000000001','magicbooklet.credits.starter','audit_5j_market_refund',1000,'refund')->>'status'$probe$)),'event_conflict','market: same event cannot debit a credit receipt');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',1000,'refund')->>'status'),'duplicate_event','market: valid replay is harmless');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_restore',2000,'restore')->>'status'),'restored','market: independent restore applies');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_2','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',3000,'refund')->>'status'$probe$)),'event_conflict','market: older consumed event remains bound after restore');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',3000,'refund')->>'status'$probe$)),'event_conflict','market: changing old timestamp cannot re-revoke restored access');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_refund',1000,'refund')->>'status'),'stale_event','market: unchanged old refund is stale');
select is((select status from public.mobile_store_transactions where store_transaction_id='audit_5j_market_1'),'active','market: old replay preserves restored receipt');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_2','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_market_other_refund',3000,'refund')->>'status'),'refunded','market: independent receipt refund applies');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',1000,'refund')->>'status'),'refunded','bundle: refund applies');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',1000,'restore')->>'status'$probe$)),'event_conflict','bundle: same event cannot change action');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',2000,'refund')->>'status'$probe$)),'event_conflict','bundle: same event cannot change timestamp');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_2','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',1000,'refund')->>'status'$probe$)),'event_conflict','bundle: same event cannot revoke another receipt');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_credit','e85a1001-0000-4000-8000-000000000001','magicbooklet.credits.starter','audit_5j_bundle_refund',1000,'refund')->>'status'$probe$)),'event_conflict','bundle: same event cannot debit a credit receipt');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',1000,'refund')->>'status'),'duplicate_event','bundle: valid replay is harmless');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_restore',2000,'restore')->>'status'),'restored','bundle: independent restore applies');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_2','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',3000,'refund')->>'status'$probe$)),'event_conflict','bundle: older consumed event remains bound after restore');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',3000,'refund')->>'status'$probe$)),'event_conflict','bundle: changing old timestamp cannot re-revoke restored access');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_refund',1000,'refund')->>'status'),'stale_event','bundle: unchanged old refund is stale');
select is((select status from public.mobile_store_transactions where store_transaction_id='audit_5j_bundle_1'),'active','bundle: old replay preserves restored receipt');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_2','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_bundle_other_refund',3000,'refund')->>'status'),'refunded','bundle: independent receipt refund applies');
select is((public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_credit','e85a1001-0000-4000-8000-000000000001','magicbooklet.credits.starter','audit_5j_credit_refund',1000,'refund')->>'status'),'refunded','credit refund control');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_market_1','e85a1001-0000-4000-8000-000000000001','audit.event.marketplace_unlock','audit_5j_credit_refund',3000,'refund')->>'status'$probe$)),'event_conflict','credit event cannot revoke marketplace access');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_credit_refund',3000,'refund')->>'status'$probe$)),'event_conflict','credit event cannot revoke legacy bundle access');
select is((pg_temp.probe_status($probe$public.reconcile_mobile_purchase_adjustment('mobile_app_store_audit_5j_bundle_1','e85a1001-0000-4000-8000-000000000001','audit.event.post_resource_unlock','audit_5j_market_restore',2000,'restore')->>'status'$probe$)),'event_conflict','marketplace event cannot claim bundle event identity');
select ok(not has_table_privilege('anon','public.mobile_purchase_adjustment_events','SELECT'),'anonymous cannot read event history');
select ok(not has_table_privilege('authenticated','public.mobile_purchase_adjustment_events','SELECT'),'clients cannot read event history');
select ok(has_table_privilege('service_role','public.mobile_purchase_adjustment_events','SELECT'),'service can inspect event history');
select ok(not has_table_privilege('service_role','public.mobile_purchase_adjustment_events','INSERT'),'service cannot forge event history outside the RPC');
select ok(not has_table_privilege('service_role','public.mobile_purchase_adjustment_events','UPDATE,DELETE,TRUNCATE'),'service cannot overwrite or erase event history');
select is((select count(*) from public.mobile_purchase_adjustment_events where provider_event_id like 'audit_5j_%'),7::bigint,'only seven successful distinct events were retained');
select is((select action from public.mobile_purchase_adjustment_events where provider_event_id='audit_5j_market_refund'),'refund','original action survives later restore');
select is((select provider_event_timestamp_ms from public.mobile_purchase_adjustment_events where provider_event_id='audit_5j_market_refund'),1000::bigint,'original timestamp survives later restore');
select * from finish();
rollback;

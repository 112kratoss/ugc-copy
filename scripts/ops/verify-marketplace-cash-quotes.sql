-- Production marketplace cash quote probe. All fixtures and transitions roll back.
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

insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,created_at)
values ('e85c0000-0000-4000-8000-000000000001','commerce-buyer@example.invalid','authenticated','authenticated','{}','{}',now()),
('e85c0002-0000-4000-8000-000000000002','commerce-seller@example.invalid','authenticated','authenticated','{}','{}',now());
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status)
values ('e85c0000-0000-4000-8000-000000000003','e85c0002-0000-4000-8000-000000000002','prompt_pack','Audit quote fixture',300,'active');
insert into public.marketplace_orders(asset_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status,quoted_price_usd_cents)
values ('e85c0000-0000-4000-8000-000000000003','e85c0000-0000-4000-8000-000000000001','order_audit_quote',24900,'INR','created',300);
-- Seller changes their price while the buyer is paying the original quote.
update public.marketplace_assets set price_usd_cents=1000 where id='e85c0000-0000-4000-8000-000000000003';
select pg_temp.is(public.complete_marketplace_purchase('order_audit_quote','pay_audit_quote'),true,'quoted checkout settles');
select pg_temp.is((select price_usd_cents from public.marketplace_purchases where asset_id='e85c0000-0000-4000-8000-000000000003'),300,'purchase retains checkout price');
select pg_temp.is((select earnings_usd_cents from public.marketplace_assets where id='e85c0000-0000-4000-8000-000000000003'),300,'sales counter uses checkout price');
select pg_temp.is((select available_token_subunits from public.creator_resource_wallets where user_id='e85c0002-0000-4000-8000-000000000002'),25500::bigint,'creator receives 85 percent of the checkout quote');

select pg_temp.is((select platform_fee_token_subunits from public.creator_resource_wallet_entries where marketplace_asset_id='e85c0000-0000-4000-8000-000000000003' and entry_kind='sale'),4500::bigint,'platform receives 15 percent of quote');
select pg_temp.is(public.complete_marketplace_purchase('order_audit_quote','pay_audit_quote'),false,'duplicate capture does not settle twice');
select pg_temp.is((select count(*) from public.creator_resource_wallet_entries where marketplace_asset_id='e85c0000-0000-4000-8000-000000000003'),1::bigint,'one sale ledger entry');
select pg_temp.throws_ok($$update public.marketplace_orders set quoted_price_usd_cents=1000 where razorpay_order_id='order_audit_quote'$$,'23514','Marketplace cash quote is immutable','quote cannot be rewritten');
select pg_temp.is(public.reconcile_marketplace_cash_adjustment('event_audit_quote_refund','pay_audit_quote','refund','audit rollback fixture')->>'status','adjusted','refund revokes purchase');
select pg_temp.is((select count(*) from public.marketplace_purchases where asset_id='e85c0000-0000-4000-8000-000000000003'),0::bigint,'refunded buyer no longer has entitlement');
select pg_temp.is((select available_token_subunits from public.creator_resource_wallets where user_id='e85c0002-0000-4000-8000-000000000002'),0::bigint,'refund reverses original creator share');
select pg_temp.is((select earnings_usd_cents from public.marketplace_assets where id='e85c0000-0000-4000-8000-000000000003'),0,'refund reverses original sales earnings');
select pg_temp.is(public.reconcile_marketplace_cash_adjustment('event_audit_quote_refund_repeat','pay_audit_quote','refund','audit duplicate')->>'status','already_adjusted','logical duplicate refund is idempotent');
select pg_temp.is((select count(*) from public.creator_resource_wallet_entries where marketplace_asset_id='e85c0000-0000-4000-8000-000000000003' and entry_kind='refund'),1::bigint,'one refund wallet entry');
-- Price decreases, including a now-free listing, must also preserve the paid quote.
insert into public.marketplace_orders(asset_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status,quoted_price_usd_cents)
values ('e85c0000-0000-4000-8000-000000000003','e85c0000-0000-4000-8000-000000000001','order_audit_quote_down',83000,'INR','created',1000);
update public.marketplace_assets set price_usd_cents=0 where id='e85c0000-0000-4000-8000-000000000003';
select pg_temp.is(public.complete_marketplace_purchase('order_audit_quote_down','pay_audit_quote_down'),true,'checkout settles after listing becomes free');
select pg_temp.is((select price_usd_cents from public.marketplace_purchases where asset_id='e85c0000-0000-4000-8000-000000000003'),1000,'lower listing price cannot underpay creator');
select pg_temp.is((select available_token_subunits from public.creator_resource_wallets where user_id='e85c0002-0000-4000-8000-000000000002'),85000::bigint,'second sale credits original quote');
insert into public.marketplace_orders(asset_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status)
values ('e85c0000-0000-4000-8000-000000000003','e85c0000-0000-4000-8000-000000000001','order_audit_quote_missing',24900,'INR','created');
select pg_temp.is(public.complete_marketplace_purchase('order_audit_quote_missing','pay_audit_quote_missing'),false,'legacy order without evidence cannot settle from mutable price');
select pg_temp.is((select status from public.marketplace_orders where razorpay_order_id='order_audit_quote_missing'),'created','missing quote remains retryable for review');
select pg_temp.is((select razorpay_payment_id from public.marketplace_orders where razorpay_order_id='order_audit_quote_missing'),null::text,'missing quote binds no payment');
select pg_temp.is((select available_token_subunits from public.creator_resource_wallets where user_id='e85c0002-0000-4000-8000-000000000002'),85000::bigint,'missing quote cannot mutate wallet');
select pg_temp.throws_ok($$insert into public.marketplace_orders(asset_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status,quoted_price_usd_cents) values ('e85c0000-0000-4000-8000-000000000003','e85c0000-0000-4000-8000-000000000001','order_audit_quote_zero',24900,'INR','created',0)$$,'23514',null,'cash quote must be positive');
select pg_temp.ok(not has_function_privilege('anon','public.complete_marketplace_purchase(text,text)','EXECUTE'),'anonymous cannot settle');
select pg_temp.ok(not has_function_privilege('authenticated','public.complete_marketplace_purchase(text,text)','EXECUTE'),'buyer cannot settle directly');
select pg_temp.ok(has_function_privilege('service_role','public.complete_marketplace_purchase(text,text)','EXECUTE'),'service can settle');
select pg_temp.ok(not has_table_privilege('authenticated','public.marketplace_orders','UPDATE'),'buyer cannot overwrite quote');


reset role;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) as commerce_audit from pg_temp.payment_audit_results;
rollback;

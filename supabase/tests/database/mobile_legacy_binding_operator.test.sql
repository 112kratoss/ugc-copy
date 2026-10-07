-- Historical receipt fixtures only: no purchase, grant, refund or provider call.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(40);

set local role anon;
select throws_ok($$select public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.market')$$,'42501',null,'anonymous binding is denied');
reset role;
set local role authenticated;
select throws_ok($$select public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.market')$$,'42501',null,'authenticated binding is denied');
reset role;

insert into auth.users(id,email,created_at,is_anonymous) values
('a0111301-0000-4000-8000-000000000001','legacy-binding@audit.invalid',now(),false);
insert into public.mobile_store_products(product_id,entitlement_type,amount_subunits,currency,credits,active) values
('audit.binding.market','marketplace_unlock',87313,'USD',null,false),
('audit.binding.alternate','marketplace_unlock',87313,'USD',null,false),
('audit.binding.post','post_resource_unlock',87313,'USD',null,false),
('audit.binding.credit','credits',41500,'INR',500,false),
('audit.binding.wrong.amount','marketplace_unlock',87314,'USD',null,false),
('audit.binding.wrong.currency','marketplace_unlock',87313,'INR',null,false),
('audit.binding.wrong.credits','credits',41500,'INR',501,false);

-- Only constructing a pre-policy post receipt bypasses the INSERT-only guard.
-- Restore it before any operator assertion; all identity triggers stay enabled.
alter table public.mobile_purchase_intents disable trigger mobile_post_resources_credit_only;
insert into public.mobile_purchase_intents(id,user_id,product_id,entitlement_type,resource_id,amount_subunits,currency,credits,status,consumed_at)
select ('a011131'||n||'-0000-4000-8000-000000000001')::uuid,
  case when n=4 then null else 'a0111301-0000-4000-8000-000000000001'::uuid end,
  case when n=5 then 'audit.binding.alternate' else 'legacy.audit.binding.'||n end,
  case when n=2 then 'post_resource_unlock' when n=3 then 'credits' else 'marketplace_unlock' end,
  case when n=3 then null else ('a011133'||n||'-0000-4000-8000-000000000001')::uuid end,
  case when n=3 then 41500 else 87313 end,
  case when n=3 then 'INR' else 'USD' end,
  case when n=3 then 500 else null end,'consumed',now()
from generate_series(1,5) n;
alter table public.mobile_purchase_intents enable trigger mobile_post_resources_credit_only;
insert into public.mobile_store_transactions(id,provider,store_transaction_id,external_order_id,user_id,product_id,purchase_intent_id,entitlement_type,resource_id,amount_subunits,currency,credits,source_record_id,status,provider_event_id,provider_event_timestamp_ms)
select ('a011132'||n||'-0000-4000-8000-000000000001')::uuid,'app_store','audit_binding_'||n,'mobile_app_store_audit_binding_'||n,
  user_id,'legacy.audit.binding.'||n,id,entitlement_type,resource_id,amount_subunits,currency,credits,
  ('a011134'||n||'-0000-4000-8000-000000000001')::uuid,
  case when n=4 then 'revoked' else 'active' end,'audit_binding_original_'||n,1000
from public.mobile_purchase_intents join generate_series(1,5) n
  on id=('a011131'||n||'-0000-4000-8000-000000000001')::uuid;

create temporary table binding_before as
select t.external_order_id,to_jsonb(t)-'product_id'-'updated_at' as receipt,
  to_jsonb(i)-'product_id'-'updated_at' as intent
from public.mobile_store_transactions t join public.mobile_purchase_intents i on i.id=t.purchase_intent_id
where t.external_order_id like 'mobile_app_store_audit_binding_%';
grant select on binding_before to service_role;

set local role service_role;
select throws_ok($$update public.mobile_store_transactions set product_id='audit.binding.market' where external_order_id='mobile_app_store_audit_binding_1'$$,'42501',null,'service role cannot bypass receipt authority by writing the table');
select throws_ok($$update public.mobile_purchase_intents set product_id='audit.binding.market' where id='a0111311-0000-4000-8000-000000000001'$$,'42501',null,'service role cannot bypass intent authority by writing the table');
select is(public.bind_legacy_mobile_store_transaction_product(null,'audit.binding.market')->>'status','invalid_request','missing order is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('web_order','audit.binding.market')->>'status','invalid_request','nonmobile order is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1',null)->>'status','invalid_request','missing product is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','  ')->>'status','invalid_request','blank product is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_missing','audit.binding.market')->>'status','not_found','unknown mobile order is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.unknown')->>'status','catalog_mismatch','unknown product is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.wrong.amount')->>'status','catalog_mismatch','price mismatch is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.wrong.currency')->>'status','catalog_mismatch','currency mismatch is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.post')->>'status','catalog_mismatch','entitlement mismatch is rejected');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_3','audit.binding.wrong.credits')->>'status','catalog_mismatch','credit quantity mismatch is rejected');
select ok(not exists(select 1 from public.mobile_store_transactions where external_order_id like 'mobile_app_store_audit_binding_%' and product_id not like 'legacy.%'),'rejected requests preserve all legacy receipt products');
select is((select product_id from public.mobile_purchase_intents where id='a0111311-0000-4000-8000-000000000001'),'legacy.audit.binding.1','rejected requests preserve the original intent product');

select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_'||n,product)->>'status','bound',label||': exact catalog product binds once')
from (values(1,'audit.binding.market','market'),(2,'audit.binding.post','historical post'),(3,'audit.binding.credit','credit'),(4,'audit.binding.market','detached revoked')) cases(n,product,label);
select ok(t.product_id=c.product and i.product_id=c.product,c.label||': receipt and intent agree with the bound product')
from (values(1,'audit.binding.market','market'),(2,'audit.binding.post','historical post'),(3,'audit.binding.credit','credit'),(4,'audit.binding.market','detached revoked')) c(n,product,label)
join public.mobile_store_transactions t on t.external_order_id='mobile_app_store_audit_binding_'||c.n
join public.mobile_purchase_intents i on i.id=t.purchase_intent_id;
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_'||n,product)->>'status','already_bound',label||': same-product retry is idempotent')
from (values(1,'audit.binding.market','market'),(2,'audit.binding.post','historical post'),(3,'audit.binding.credit','credit'),(4,'audit.binding.market','detached revoked')) cases(n,product,label);
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.alternate')->>'status','identity_conflict','a second valid same-tier product cannot rebind the receipt');
select is(public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_1','audit.binding.unknown')->>'status','identity_conflict','unknown product cannot replace a completed binding');
select is((select product_id from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_binding_1'),'audit.binding.market','conflict preserves the first receipt product');
select is((select product_id from public.mobile_purchase_intents where id='a0111311-0000-4000-8000-000000000001'),'audit.binding.market','conflict preserves the first intent product');
select ok(not (select active from public.mobile_store_products where product_id='audit.binding.market'),'binding a retired SKU does not reactivate catalog authority');
select ok((select user_id is null and status='revoked' from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_binding_4'),'binding preserves anonymized account and revocation state');

select throws_ok($$select public.bind_legacy_mobile_store_transaction_product('mobile_app_store_audit_binding_5','audit.binding.market')$$,'P0001','mobile purchase intent product authority is immutable','inconsistent pre-bound intent rejects the receipt update atomically');
select is((select product_id from public.mobile_store_transactions where external_order_id='mobile_app_store_audit_binding_5'),'legacy.audit.binding.5','failed intent update leaves receipt unbound');
select is((select product_id from public.mobile_purchase_intents where id='a0111315-0000-4000-8000-000000000001'),'audit.binding.alternate','failed binding leaves inconsistent intent unchanged');
select ok(not exists(select 1 from binding_before b join public.mobile_store_transactions t on t.external_order_id=b.external_order_id join public.mobile_purchase_intents i on i.id=t.purchase_intent_id where b.receipt is distinct from to_jsonb(t)-'product_id'-'updated_at' or b.intent is distinct from to_jsonb(i)-'product_id'-'updated_at'),'binding and retries preserve every other receipt and intent identity/state field');
reset role;
select ok((select credits=0 and promotional_credits=0 from public.profiles where id='a0111301-0000-4000-8000-000000000001') and not exists(select 1 from public.transactions where user_id='a0111301-0000-4000-8000-000000000001'),'catalog binding does not credit the account or create a purchase');
select ok((select tgenabled='O' from pg_trigger where tgname='mobile_post_resources_credit_only' and tgrelid='public.mobile_purchase_intents'::regclass),'credit-only policy is restored during all binding controls');

select * from finish();
rollback;

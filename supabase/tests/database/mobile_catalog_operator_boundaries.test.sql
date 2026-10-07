begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(35);

set local role anon;
select throws_ok(sql,'42501',null,'anonymous catalog operator call is denied') from (values
($$select public.provision_mobile_store_product('audit.denied','marketplace_unlock',87213,'USD')$$),
($$select public.set_mobile_store_product_active('audit.denied',false)$$),
($$select * from public.list_mobile_store_product_provisioning_gaps()$$)) cases(sql);
reset role;
set local role authenticated;
select throws_ok(sql,'42501',null,'authenticated catalog operator call is denied') from (values
($$select public.provision_mobile_store_product('audit.denied','marketplace_unlock',87213,'USD')$$),
($$select public.set_mobile_store_product_active('audit.denied',false)$$),
($$select * from public.list_mobile_store_product_provisioning_gaps()$$)) cases(sql);
reset role;

insert into auth.users(id,email,created_at,is_anonymous) values ('a0111201-0000-4000-8000-000000000001','catalog-operator@audit.invalid',now(),false);
insert into public.marketplace_assets(id,seller_user_id,type,title,price_usd_cents,status) values
('a0111202-0000-4000-8000-000000000001','a0111201-0000-4000-8000-000000000001','prompt_pack','Catalog active fixture',87213,'active'),
('a0111203-0000-4000-8000-000000000001','a0111201-0000-4000-8000-000000000001','prompt_pack','Catalog unlisted fixture',87213,'unlisted'),
('a0111204-0000-4000-8000-000000000001','a0111201-0000-4000-8000-000000000001','prompt_pack','Catalog draft fixture',87214,'draft');
set local role service_role;
select is((select active_resource_count from public.list_mobile_store_product_provisioning_gaps() where entitlement_type='marketplace_unlock' and amount_subunits=87213),2::bigint,'active and unlisted resources are counted as a missing tier');
select is(public.provision_mobile_store_product('audit.operator.sku.one','marketplace_unlock',87213,'USD')->>'status','provisioned','operator provisions its isolated tier');
select ok((select active and amount_subunits=87213 and currency='USD' and credits is null from public.mobile_store_products where product_id='audit.operator.sku.one'),'catalog configuration matches resource currency and amount without credits');
select is((select count(*) from public.list_mobile_store_product_provisioning_gaps() where entitlement_type='marketplace_unlock' and amount_subunits in (87213,87214)),0::bigint,'configured active tier and unoffered draft tier have no gap');
select is(public.provision_mobile_store_product('audit.operator.sku.one','marketplace_unlock',87213,'USD')->>'status','already_configured','same product configuration is idempotent');
select is(public.provision_mobile_store_product('audit.operator.sku.one','marketplace_unlock',87214,'USD')->>'status','product_conflict','existing product cannot change price');
select is(public.provision_mobile_store_product('audit.operator.sku.two','marketplace_unlock',87213,'USD')->>'status','tier_already_configured','duplicate active tier cannot get another SKU');
select ok(not exists(select 1 from public.mobile_store_products where product_id='audit.operator.sku.two'),'rejected duplicate tier leaves no SKU');
select is(public.provision_mobile_store_product('audit.operator.invalid','credits',87213,'USD')->>'status','invalid_request','operator cannot create a new credit pack');
select is(public.provision_mobile_store_product('audit.operator.invalid','marketplace_unlock',99,'USD')->>'status','invalid_request','below-minimum amount is rejected');
select is(public.provision_mobile_store_product('audit.operator.invalid','marketplace_unlock',87213,'INR')->>'status','invalid_request','resource product currency must be USD');
select is(public.provision_mobile_store_product('   ','marketplace_unlock',87213,'USD')->>'status','invalid_request','blank SKU is rejected');
select is(public.provision_mobile_store_product(' audit.operator.invalid ','marketplace_unlock',87213,'USD')->>'status','invalid_request','SKU with spaces is rejected');
select is(public.set_mobile_store_product_active('audit.operator.sku.one',null)->>'status','invalid_request','missing activation decision is rejected');
select is(public.set_mobile_store_product_active('audit.operator.missing',false)->>'status','not_found','unknown SKU is rejected');
select is(public.set_mobile_store_product_active('magicbooklet.credits.starter',false)->>'status','fixed_credit_product','seeded credit pack cannot be deactivated');
select ok((select active from public.mobile_store_products where product_id='magicbooklet.credits.starter'),'fixed credit pack remains active');
select is(public.set_mobile_store_product_active('audit.operator.sku.one',false)->>'status','deactivated','resource SKU can be deactivated');
select is((select active_resource_count from public.list_mobile_store_product_provisioning_gaps() where entitlement_type='marketplace_unlock' and amount_subunits=87213),2::bigint,'deactivation restores the missing-tier count');
select is(public.set_mobile_store_product_active('audit.operator.sku.one',false)->>'status','already_configured','repeated deactivation is idempotent');
select is(public.provision_mobile_store_product('audit.operator.sku.two','marketplace_unlock',87213,'USD')->>'status','provisioned','inactive tier can receive its replacement SKU');
select is(public.set_mobile_store_product_active('audit.operator.sku.one',true)->>'status','tier_already_configured','old SKU cannot reactivate over an active replacement');
select ok(not (select active from public.mobile_store_products where product_id='audit.operator.sku.one'),'conflicting activation leaves old SKU inactive');
select is(public.set_mobile_store_product_active('audit.operator.sku.two',false)->>'status','deactivated','replacement SKU can be deactivated');
select is(public.set_mobile_store_product_active('audit.operator.sku.one',true)->>'status','activated','original SKU can reactivate once tier is vacant');
select is((select count(*) from public.mobile_store_products where entitlement_type='marketplace_unlock' and amount_subunits=87213 and currency='USD' and active),1::bigint,'only one SKU is active for the tier');
select is((select count(*) from public.list_mobile_store_product_provisioning_gaps() where entitlement_type='marketplace_unlock' and amount_subunits=87213),0::bigint,'reactivated tier has no gap');
select ok((select amount_subunits=87213 and currency='USD' and credits is null from public.mobile_store_products where product_id='audit.operator.sku.one'),'conflicts and toggles preserve original product authority');
reset role;
select ok((select credits=0 and promotional_credits=0 from public.profiles where id='a0111201-0000-4000-8000-000000000001') and not exists(select 1 from public.marketplace_assets where seller_user_id='a0111201-0000-4000-8000-000000000001' and (sales_count<>0 or earnings_usd_cents<>0)),'catalog operations do not settle purchases or change fixture balances');

select * from finish();
rollback;

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(23);

create temporary table cash_detachment_fixture (
  tag text primary key, seller uuid, buyer uuid, bundle uuid, post uuid,
  order_id uuid, purchase uuid, action text, expected_status text
);
DO $fixture$
#variable_conflict use_variable
DECLARE
  item record;
  seller_id uuid;
  buyer_id uuid := gen_random_uuid();
  bundle_id uuid;
  post_id uuid;
  order_id uuid;
  purchase_id uuid;
BEGIN
  insert into auth.users(id,email,aud,role,created_at)
    values(buyer_id,buyer_id::text||'@example.invalid','authenticated','authenticated',now());
  FOR item IN SELECT * FROM (VALUES
    ('auth-refund','refund'),('auth-dispute','dispute'),('auth-restore','restore'),
    ('auth-pending','refund')
  ) AS cases(tag,action)
  LOOP
    seller_id := gen_random_uuid(); bundle_id := gen_random_uuid(); post_id := gen_random_uuid(); order_id := gen_random_uuid();
    insert into auth.users(id,email,aud,role,created_at)
      values(seller_id,seller_id::text||'@example.invalid','authenticated','authenticated',now());
    insert into public.posts(id,user_id,visibility,category,source_kind,post_format,body)
      values(post_id,seller_id,'public','text','external','text','Detached refund fixture');
    insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,price_usd_cents,prompt_text)
      values(bundle_id,post_id,seller_id,'paid','published','Detached refund fixture',100,'paid fixture');
    insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,amount_subunits,currency,status,quoted_price_usd_cents,quoted_revision_id,quoted_content_fingerprint,quoted_media)
      select order_id,bundle_id,buyer_id,'audit-detached-'||item.tag,8300,'INR','created',100,revisions.id,content_fingerprint,'[]'::jsonb
      from public.post_resource_bundle_revisions AS revisions where revisions.bundle_id=bundle_id;
    IF item.tag <> 'auth-pending' THEN
      IF NOT public.complete_post_resource_bundle_purchase('audit-detached-'||item.tag,'audit-pay-'||item.tag) THEN
        RAISE EXCEPTION 'Fixture capture failed';
      END IF;
      select id into purchase_id from public.post_resource_bundle_purchases where post_resource_bundle_purchases.order_id=order_id;
    ELSE
      purchase_id := NULL;
    END IF;
    insert into cash_detachment_fixture values(item.tag,seller_id,buyer_id,bundle_id,post_id,order_id,purchase_id,item.action,CASE WHEN item.action='restore' THEN 'manual_review' ELSE 'adjusted' END);
    delete from auth.users where id=seller_id;
  END LOOP;
END;
$fixture$;

grant select on cash_detachment_fixture to service_role;
create temporary table cash_detachment_results(tag text, result jsonb, replay jsonb);
grant insert on cash_detachment_results to service_role;
set local role service_role;
insert into cash_detachment_results(tag,result)
  select tag,public.reconcile_post_resource_cash_adjustment('audit-event-'||tag,'audit-pay-'||tag,action,'Isolated SQL fixture','audit-detached-'||tag)
  from cash_detachment_fixture;
insert into cash_detachment_results(tag,replay)
  select tag,public.reconcile_post_resource_cash_adjustment('audit-event-'||tag,'audit-pay-'||tag,action,NULL,'audit-detached-'||tag)
  from cash_detachment_fixture;
reset role;

select is(result->>'status',expected_status,tag||' reconciles detached order')
  from cash_detachment_results join cash_detachment_fixture using(tag) where result is not null order by tag;
select is(replay->>'status',CASE WHEN action='restore' THEN 'manual_review' ELSE 'already_adjusted' END,tag||' replay is idempotent')
  from cash_detachment_results join cash_detachment_fixture using(tag) where replay is not null order by tag;
select is(orders.status,CASE WHEN action='restore' THEN 'paid' ELSE 'failed' END,tag||' preserves correct financial state')
  from cash_detachment_fixture fixtures join public.post_resource_bundle_orders orders on orders.id=fixtures.order_id order by tag;
select is((select count(*)::integer from public.post_resource_bundle_purchases purchases where purchases.order_id=fixtures.order_id),CASE WHEN action='restore' THEN 1 ELSE 0 END,tag||' retains or revokes entitlement')
  from cash_detachment_fixture fixtures order by tag;

select is(public.reconcile_post_resource_cash_adjustment('audit-event-auth-refund','wrong-payment','refund',NULL,'audit-detached-auth-refund')->>'status','event_conflict','detached duplicate cannot rebind payment');
select is(public.reconcile_post_resource_cash_adjustment('audit-event-auth-refund','audit-pay-auth-refund','dispute',NULL,'audit-detached-auth-refund')->>'status','event_conflict','detached duplicate cannot rebind action');
select is(public.reconcile_post_resource_cash_adjustment('audit-event-auth-refund','audit-pay-auth-refund','refund',NULL,'wrong-order')->>'status','order_conflict','detached duplicate cannot rebind order');
select ok(not has_function_privilege('anon','public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)','EXECUTE'),'anonymous cannot reconcile');
select ok(not has_function_privilege('authenticated','public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)','EXECUTE'),'client cannot reconcile');
select ok(has_function_privilege('service_role','public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)','EXECUTE'),'service can reconcile');
select is(public.complete_post_resource_bundle_purchase('audit-detached-auth-pending','audit-pay-auth-pending'),false,'detached pending capture cannot grant after refund');
select * from finish();
rollback;

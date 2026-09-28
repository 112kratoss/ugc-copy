-- Production bundle cash refund probe. All fixtures and transitions roll back.
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
('e85d0001-0000-4000-8000-000000000001','bundle-race-0@example.invalid','authenticated','authenticated',now()),
('e85d0002-0000-4000-8000-000000000001','bundle-race-1@example.invalid','authenticated','authenticated',now());
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts (
  id,
  user_id,
  visibility,
  category,
  source_kind,
  post_format,
  body
)
values (
  'e85d0003-0000-4000-8000-000000000001'::uuid,
  'e85d0002-0000-4000-8000-000000000001'::uuid,
  'public',
  'text',
  'external',
  'text',
  'Cash bundle post'
);

insert into public.post_resource_bundles (
  id,
  post_id,
  owner_user_id,
  access_mode,
  status,
  title,
  price_usd_cents,
  prompt_text
)
values (
  'e85d0004-0000-4000-8000-000000000001'::uuid,
  'e85d0003-0000-4000-8000-000000000001'::uuid,
  'e85d0002-0000-4000-8000-000000000001'::uuid,
  'paid',
  'published',
  'Cash resource bundle',
  200,
  'Paid prompt'
);

-- Created orders must carry the immutable quote checkout would have pinned;
-- the bundle insert above minted revision 1, so all three orders below quote
-- that revision at its 200-cent price.
insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status,
  quoted_price_usd_cents,
  quoted_revision_id,
  quoted_content_fingerprint,
  quoted_media
)
values (
  'e85d0005-0000-4000-8000-000000000001'::uuid,
  'e85d0004-0000-4000-8000-000000000001'::uuid,
  'e85d0001-0000-4000-8000-000000000001'::uuid,
  'order_race_audit_cash_1',
  19900,
  'INR',
  'created',
  200,
  (select id from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  (select content_fingerprint from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  '[]'::jsonb
);

select pg_temp.is(
  public.complete_post_resource_bundle_purchase(
    'order_race_audit_cash_1',
    'pay_race_audit_cash_1'
  ),
  true,
  'a captured resource order grants its entitlement'
);

select pg_temp.is(
  (
    select jsonb_build_array(
      bundles.sales_count,
      wallets.available_token_subunits
    )
    from public.post_resource_bundles bundles
    join public.creator_resource_wallets wallets
      on wallets.user_id = bundles.owner_user_id
    where bundles.id = 'e85d0004-0000-4000-8000-000000000001'::uuid
  ),
  '[1,17000]'::jsonb,
  'resource completion settles the creator wallet once'
);

insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status,
  quoted_price_usd_cents,
  quoted_revision_id,
  quoted_content_fingerprint,
  quoted_media
)
values (
  'e85d0006-0000-4000-8000-000000000001'::uuid,
  'e85d0004-0000-4000-8000-000000000001'::uuid,
  'e85d0001-0000-4000-8000-000000000001'::uuid,
  'order_race_audit_duplicate_checkout',
  19900,
  'INR',
  'created',
  200,
  (select id from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  (select content_fingerprint from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  '[]'::jsonb
);

select pg_temp.is(
  public.complete_post_resource_bundle_purchase(
    'order_race_audit_duplicate_checkout',
    'pay_race_audit_duplicate_checkout'
  ),
  false,
  'a second resource checkout cannot duplicate an existing entitlement'
);
select pg_temp.is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.post_resource_bundle_orders
    where id = 'e85d0006-0000-4000-8000-000000000001'::uuid
  ),
  '["failed","pay_race_audit_duplicate_checkout"]'::jsonb,
  'a duplicate resource checkout becomes terminal instead of orphan-paid'
);

select pg_temp.is(
  public.reconcile_post_resource_cash_adjustment(
    'event_race_audit_refund_1',
    'pay_race_audit_cash_1',
    'refund',
    'test refund'
  ) ->> 'status',
  'adjusted',
  'a resource refund atomically revokes the entitlement'
);

select pg_temp.is(
  (
    select count(*)::integer
    from public.post_resource_bundle_purchases
    where order_id = 'e85d0005-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'the refunded resource entitlement is gone'
);

select pg_temp.is(
  (
    select status
    from public.post_resource_bundle_orders
    where id = 'e85d0005-0000-4000-8000-000000000001'::uuid
  ),
  'failed',
  'the refunded resource order is no longer paid'
);

select pg_temp.is(
  (
    select sales_count
    from public.post_resource_bundles
    where id = 'e85d0004-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'resource sales_count reverses exactly once'
);

select pg_temp.is(
  (
    select count(*)::integer
    from public.creator_resource_wallet_entries
    where order_id = 'e85d0005-0000-4000-8000-000000000001'::uuid
      and entry_kind = 'refund'
  ),
  1,
  'the existing creator ledger records one refund reversal'
);

select pg_temp.is(
  (
    select available_token_subunits
    from public.creator_resource_wallets
    where user_id = 'e85d0002-0000-4000-8000-000000000001'::uuid
  ),
  0::bigint,
  'the resource refund reverses creator available earnings'
);

select pg_temp.is(
  public.reconcile_post_resource_cash_adjustment(
    'event_race_audit_refund_1',
    'pay_race_audit_cash_1',
    'refund',
    'same event replay'
  ) ->> 'status',
  'already_adjusted',
  'the same resource refund event is idempotent'
);

select pg_temp.is(
  (
    select count(*)::integer
    from public.cash_purchase_adjustments
    where purchase_kind = 'post_resource'
      and provider_payment_id = 'pay_race_audit_cash_1'
      and action = 'refund'
  ),
  1,
  'exactly one resource refund ledger row exists'
);

select pg_temp.is(
  public.reconcile_post_resource_cash_adjustment(
    'event_race_audit_restore_1',
    'pay_race_audit_cash_1',
    'restore',
    'dispute won'
  ) ->> 'status',
  'manual_review',
  'resource restoration is fail-closed for manual review'
);

insert into public.post_resource_bundle_orders (
  id,
  bundle_id,
  buyer_user_id,
  razorpay_order_id,
  amount_subunits,
  currency,
  status,
  quoted_price_usd_cents,
  quoted_revision_id,
  quoted_content_fingerprint,
  quoted_media
)
values (
  'e85d0007-0000-4000-8000-000000000001'::uuid,
  'e85d0004-0000-4000-8000-000000000001'::uuid,
  'e85d0001-0000-4000-8000-000000000001'::uuid,
  'order_race_audit_refund_before_capture',
  19900,
  'INR',
  'created',
  200,
  (select id from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  (select content_fingerprint from public.post_resource_bundle_revisions
   where bundle_id = 'e85d0004-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  '[]'::jsonb
);

select pg_temp.is(
  public.reconcile_post_resource_cash_adjustment(
    'event_race_audit_refund_before_capture',
    'pay_race_audit_refund_before_capture',
    'refund',
    'refund raced ahead of capture',
    'order_race_audit_refund_before_capture'
  ) ->> 'status',
  'adjusted',
  'a resource refund before capture is durably applied'
);
select pg_temp.is(
  (
    select jsonb_build_array(status, razorpay_payment_id)
    from public.post_resource_bundle_orders
    where id = 'e85d0007-0000-4000-8000-000000000001'::uuid
  ),
  '["failed","pay_race_audit_refund_before_capture"]'::jsonb,
  'the pre-capture resource refund binds the payment and fails the order'
);
select pg_temp.is(
  public.complete_post_resource_bundle_purchase(
    'order_race_audit_refund_before_capture',
    'pay_race_audit_refund_before_capture'
  ),
  false,
  'a delayed resource capture cannot revive the failed order'
);
select pg_temp.is(
  (
    select count(*)::integer
    from public.post_resource_bundle_purchases
    where order_id = 'e85d0007-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'the pre-capture resource refund never grants an entitlement'
);

select pg_temp.ok(
  not has_function_privilege(
    'authenticated',
    'public.reconcile_marketplace_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot reconcile marketplace cash adjustments'
);
select pg_temp.ok(
  not has_function_privilege(
    'authenticated',
    'public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated cannot reconcile resource cash adjustments'
);
select pg_temp.ok(
  has_function_privilege(
    'service_role',
    'public.reconcile_marketplace_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reconcile marketplace cash adjustments'
);
select pg_temp.ok(
  has_function_privilege(
    'service_role',
    'public.reconcile_post_resource_cash_adjustment(text,text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reconcile resource cash adjustments'
);
select pg_temp.ok(
  not has_table_privilege(
    'authenticated',
    'public.cash_purchase_adjustments',
    'SELECT'
  ),
  'authenticated cannot query the cash adjustment ledger'
);

reset role;
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(label order by label)) as bundle_refund_audit from pg_temp.payment_audit_results;
rollback;

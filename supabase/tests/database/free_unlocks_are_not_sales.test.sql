-- Free unlocks are not sales (20261017145444_free_unlocks_are_not_sales.sql): a
-- free unlock moves free_unlock_count only and a paid one sales_count only; the
-- reads hand both out; and the backfill splits a seeded mix of histories (free,
-- paid, free then paid with a refunded cash sale, paid then free, a drifted
-- count) by what each buyer paid, never into a paid count and never below zero.
--
-- Every unlock is made by the RPC that makes it in production. The backfill is
-- then replayed by putting the free counts back into sales_count, as the old
-- free unlock had counted them.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(49);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- One seller; five buyers with purchased credits.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, raw_app_meta_data, raw_user_meta_data) values
  ('f6000001-0000-4000-8000-000000000001', 'free-split-seller@example.invalid', 'authenticated', 'authenticated', false, now(), '{}', '{}'),
  ('f6000002-0000-4000-8000-000000000002', 'free-split-buyer-1@example.invalid', 'authenticated', 'authenticated', false, now(), '{}', '{}'),
  ('f6000003-0000-4000-8000-000000000003', 'free-split-buyer-2@example.invalid', 'authenticated', 'authenticated', false, now(), '{}', '{}'),
  ('f6000004-0000-4000-8000-000000000004', 'free-split-buyer-3@example.invalid', 'authenticated', 'authenticated', false, now(), '{}', '{}'),
  ('f6000005-0000-4000-8000-000000000005', 'free-split-buyer-4@example.invalid', 'authenticated', 'authenticated', false, now(), '{}', '{}');

update public.profiles set credits = 1000, promotional_credits = 0
where id in (
  'f6000002-0000-4000-8000-000000000002',
  'f6000003-0000-4000-8000-000000000003',
  'f6000004-0000-4000-8000-000000000004',
  'f6000005-0000-4000-8000-000000000005'
);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body) values
  ('f6100001-0000-4000-8000-000000000001', 'f6000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Free recipe post'),
  ('f6100002-0000-4000-8000-000000000002', 'f6000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Paid recipe post'),
  ('f6100003-0000-4000-8000-000000000003', 'f6000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Free then paid recipe post'),
  ('f6100004-0000-4000-8000-000000000004', 'f6000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Paid then free recipe post'),
  ('f6100005-0000-4000-8000-000000000005', 'f6000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Drifted recipe post'),
  ('f6100006-0000-4000-8000-000000000006', 'f6000001-0000-4000-8000-000000000001', 'private', 'text', 'external', 'text', 'Draft recipe post');

insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text) values
  ('f6200001-0000-4000-8000-000000000001', 'f6100001-0000-4000-8000-000000000001', 'f6000001-0000-4000-8000-000000000001', 'free', 'published', 'Free recipe', 0, 'Free prompt'),
  ('f6200002-0000-4000-8000-000000000002', 'f6100002-0000-4000-8000-000000000002', 'f6000001-0000-4000-8000-000000000001', 'paid', 'published', 'Paid recipe', 200, 'Paid prompt'),
  ('f6200003-0000-4000-8000-000000000003', 'f6100003-0000-4000-8000-000000000003', 'f6000001-0000-4000-8000-000000000001', 'free', 'published', 'Free then paid recipe', 0, 'Changing prompt'),
  ('f6200004-0000-4000-8000-000000000004', 'f6100004-0000-4000-8000-000000000004', 'f6000001-0000-4000-8000-000000000001', 'paid', 'published', 'Paid then free recipe', 300, 'Repriced prompt'),
  ('f6200005-0000-4000-8000-000000000005', 'f6100005-0000-4000-8000-000000000005', 'f6000001-0000-4000-8000-000000000001', 'free', 'published', 'Drifted recipe', 0, 'Drifted prompt'),
  ('f6200006-0000-4000-8000-000000000006', 'f6100006-0000-4000-8000-000000000006', 'f6000001-0000-4000-8000-000000000001', 'free', 'draft', 'Draft recipe', 0, 'Draft prompt');

-- ─── The counter ────────────────────────────────────────────────────────────
select has_column('public', 'post_resource_bundles', 'free_unlock_count', 'a bundle carries a free unlock counter');
select col_not_null('public', 'post_resource_bundles', 'free_unlock_count', 'the counter is never null');
select col_default_is('public', 'post_resource_bundles', 'free_unlock_count', '0', 'the counter starts at zero');
select throws_ok(
  $$update public.post_resource_bundles set free_unlock_count = -1 where id = 'f6200001-0000-4000-8000-000000000001'$$,
  '23514', NULL, 'the counter never goes below zero');
select ok(not has_column_privilege('anon', 'public.post_resource_bundles', 'free_unlock_count', 'SELECT'),
  'a visitor cannot read the counter directly');
select ok(not has_column_privilege('authenticated', 'public.post_resource_bundles', 'free_unlock_count', 'SELECT'),
  'a signed-in client cannot read the counter directly');
select ok(not has_column_privilege('authenticated', 'public.post_resource_bundles', 'free_unlock_count', 'UPDATE'),
  'a signed-in client cannot write the counter');
select ok(
  not has_function_privilege('service_role', 'public.split_post_resource_bundle_free_unlocks()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.split_post_resource_bundle_free_unlocks()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.split_post_resource_bundle_free_unlocks()', 'EXECUTE'),
  'only the database owner runs the split');
select ok(
  pg_get_function_result('public.list_marketplace_resource_bundles(text,text,text,text,text,integer,integer)'::regprocedure)
    like '%sales_count integer, free_unlock_count integer%',
  'the marketplace listing hands out both counts');

-- ─── Unlocks from here on ───────────────────────────────────────────────────
select is(public.unlock_free_post_resource_bundle('f6000002-0000-4000-8000-000000000002', 'f6100001-0000-4000-8000-000000000001', 'free_bundle_split_1', 'free_unlock_split_1')->>'status',
  'completed', 'a free unlock completes');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200001-0000-4000-8000-000000000001'),
  array[0, 1], 'a free unlock moves free_unlock_count only');
select is(public.unlock_free_post_resource_bundle('f6000002-0000-4000-8000-000000000002', 'f6100001-0000-4000-8000-000000000001', 'free_bundle_split_1_again', 'free_unlock_split_1_again')->>'status',
  'already_owned', 'a second free unlock by the same buyer is refused');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200001-0000-4000-8000-000000000001'),
  array[0, 1], 'and counts nothing');
select is(public.unlock_post_resource_bundle_with_credits('f6000002-0000-4000-8000-000000000002', 'f6100002-0000-4000-8000-000000000002')->>'status',
  'completed', 'a paid unlock completes');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200002-0000-4000-8000-000000000002'),
  array[1, 0], 'a paid unlock moves sales_count only');
select is(
  (select array_agg(sales_count order by bundle_id) from public.marketplace_bundle_listings
   where bundle_id in ('f6200001-0000-4000-8000-000000000001', 'f6200002-0000-4000-8000-000000000002')),
  array[0, 1], 'the listing''s top-sales key counts the paid unlock and not the free one');

-- ─── The reads ──────────────────────────────────────────────────────────────
select is(public.get_owner_post_sales_summary('f6000001-0000-4000-8000-000000000001') - 'earningsUsdCents' - 'listingCount',
  '{"salesCount": 1, "freeUnlockCount": 1}'::jsonb, 'the owner''s totals count paid sales and free unlocks apart');
select is((select array[sales_count, free_unlock_count] from public.get_owner_post_bundle_summaries(array['f6100001-0000-4000-8000-000000000001']::uuid[])),
  array[0, 1], 'the owner''s post rows carry both counts');
select is((select array[sales_count, free_unlock_count] from public.get_public_post_resource_bundle_summaries(array['f6100001-0000-4000-8000-000000000001']::uuid[])),
  array[0, 1], 'a published bundle''s public summary carries both counts');
select ok((select sales_count is null and free_unlock_count is null
           from public.get_public_post_resource_bundle_summaries(array['f6100006-0000-4000-8000-000000000006']::uuid[])),
  'a draft bundle''s public summary carries neither');

-- ─── The backfill: a seeded mix of histories ────────────────────────────────
-- The free recipe: two more free unlocks (three in all).
select is(public.unlock_free_post_resource_bundle('f6000003-0000-4000-8000-000000000003', 'f6100001-0000-4000-8000-000000000001', 'free_bundle_split_2', 'free_unlock_split_2')->>'status',
  'completed', 'fixture: second free unlock of the free recipe');
select is(public.unlock_free_post_resource_bundle('f6000004-0000-4000-8000-000000000004', 'f6100001-0000-4000-8000-000000000001', 'free_bundle_split_3', 'free_unlock_split_3')->>'status',
  'completed', 'fixture: third free unlock of the free recipe');

-- Free then paid: two free unlocks, a repricing, a credit sale, and a cash sale
-- that is captured and then refunded.
select is(public.unlock_free_post_resource_bundle('f6000002-0000-4000-8000-000000000002', 'f6100003-0000-4000-8000-000000000003', 'free_bundle_split_4', 'free_unlock_split_4')->>'status',
  'completed', 'fixture: first free unlock before the repricing');
select is(public.unlock_free_post_resource_bundle('f6000003-0000-4000-8000-000000000003', 'f6100003-0000-4000-8000-000000000003', 'free_bundle_split_5', 'free_unlock_split_5')->>'status',
  'completed', 'fixture: second free unlock before the repricing');
update public.post_resource_bundles set access_mode = 'paid', price_usd_cents = 200
where id = 'f6200003-0000-4000-8000-000000000003';
select is(public.unlock_post_resource_bundle_with_credits('f6000004-0000-4000-8000-000000000004', 'f6100003-0000-4000-8000-000000000003')->>'status',
  'completed', 'fixture: a credit sale after the repricing');
insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, amount_subunits, currency, status,
  quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media
)
select 'f6300001-0000-4000-8000-000000000001', 'f6200003-0000-4000-8000-000000000003', 'f6000005-0000-4000-8000-000000000005',
       'order_free_split_cash', 19900, 'INR', 'created', 200, revisions.id, revisions.content_fingerprint, '[]'::jsonb
from public.post_resource_bundle_revisions as revisions
where revisions.bundle_id = 'f6200003-0000-4000-8000-000000000003'
order by revisions.revision_number desc
limit 1;
select is(public.complete_post_resource_bundle_purchase('order_free_split_cash', 'pay_free_split_cash'),
  true, 'fixture: a cash sale is captured');
select is(public.reconcile_post_resource_cash_adjustment('event_free_split_refund', 'pay_free_split_cash', 'refund', 'free split test refund')->>'status',
  'adjusted', 'fixture: and refunded');

-- Paid then free: a credit sale, then a repricing to free made before sold
-- recipes froze (20260806120000), so the freeze is set aside for it, and two
-- free unlocks.
select is(public.unlock_post_resource_bundle_with_credits('f6000002-0000-4000-8000-000000000002', 'f6100004-0000-4000-8000-000000000004')->>'status',
  'completed', 'fixture: a credit sale before the repricing');
alter table public.post_resource_bundles disable trigger post_resource_bundles_protect_sold_content;
update public.post_resource_bundles set access_mode = 'free', price_usd_cents = 0
where id = 'f6200004-0000-4000-8000-000000000004';
alter table public.post_resource_bundles enable trigger post_resource_bundles_protect_sold_content;
select is(public.unlock_free_post_resource_bundle('f6000003-0000-4000-8000-000000000003', 'f6100004-0000-4000-8000-000000000004', 'free_bundle_split_6', 'free_unlock_split_6')->>'status',
  'completed', 'fixture: first free unlock after the repricing');
select is(public.unlock_free_post_resource_bundle('f6000004-0000-4000-8000-000000000004', 'f6100004-0000-4000-8000-000000000004', 'free_bundle_split_7', 'free_unlock_split_7')->>'status',
  'completed', 'fixture: second free unlock after the repricing');

-- The drifted recipe: two free unlocks.
select is(public.unlock_free_post_resource_bundle('f6000002-0000-4000-8000-000000000002', 'f6100005-0000-4000-8000-000000000005', 'free_bundle_split_8', 'free_unlock_split_8')->>'status',
  'completed', 'fixture: first free unlock of the drifted recipe');
select is(public.unlock_free_post_resource_bundle('f6000003-0000-4000-8000-000000000003', 'f6100005-0000-4000-8000-000000000005', 'free_bundle_split_9', 'free_unlock_split_9')->>'status',
  'completed', 'fixture: second free unlock of the drifted recipe');

-- Back to the counts as the old free unlock left them, and one free unlock the
-- drifted recipe never counted.
update public.post_resource_bundles
set sales_count = sales_count + free_unlock_count, free_unlock_count = 0
where owner_user_id = 'f6000001-0000-4000-8000-000000000001';
update public.post_resource_bundles set sales_count = 1
where id = 'f6200005-0000-4000-8000-000000000005';

select is(
  (select array_agg(array[sales_count, free_unlock_count] order by id) from public.post_resource_bundles
   where owner_user_id = 'f6000001-0000-4000-8000-000000000001'),
  array[[3, 0], [1, 0], [3, 0], [3, 0], [1, 0], [0, 0]],
  'fixture: every unlock counted as a sale, as before 2026-10-17');
select is(
  (select array_agg(array[
     (select count(*)::integer from public.post_resource_bundle_purchases as purchases
      where purchases.bundle_id = bundles.id and purchases.price_usd_cents = 0),
     (select count(*)::integer from public.post_resource_bundle_purchases as purchases
      where purchases.bundle_id = bundles.id and purchases.price_usd_cents > 0)
   ] order by bundles.id)
   from public.post_resource_bundles as bundles
   where bundles.owner_user_id = 'f6000001-0000-4000-8000-000000000001'),
  array[[3, 0], [0, 1], [2, 1], [2, 1], [2, 0], [0, 0]],
  'fixture: free and paid purchases per bundle; the refunded cash sale left none');

select is(public.split_post_resource_bundle_free_unlocks(), 4, 'the split moves counts on the four bundles with free purchases');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200001-0000-4000-8000-000000000001'),
  array[0, 3], 'a free recipe''s unlocks all become free unlocks');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200002-0000-4000-8000-000000000002'),
  array[1, 0], 'a paid recipe keeps its sale');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200003-0000-4000-8000-000000000003'),
  array[1, 2], 'free then paid: the free unlocks move, the kept sale stays, the refunded one counts nowhere');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200004-0000-4000-8000-000000000004'),
  array[1, 2], 'paid then free: the sale stays a sale, whatever the recipe costs today');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200005-0000-4000-8000-000000000005'),
  array[0, 1], 'a count short of its free purchases moves what it holds and stops at zero');
select is(
  (select array_agg(sales_count order by bundle_id) from public.marketplace_bundle_listings
   where bundle_id in ('f6200001-0000-4000-8000-000000000001', 'f6200003-0000-4000-8000-000000000003', 'f6200004-0000-4000-8000-000000000004')),
  array[0, 1, 1], 'the listing''s top-sales key follows the paid counts');

select is(public.split_post_resource_bundle_free_unlocks(), 0, 'a second run moves nothing');
select is(
  (select array_agg(array[sales_count, free_unlock_count] order by id) from public.post_resource_bundles
   where owner_user_id = 'f6000001-0000-4000-8000-000000000001'),
  array[[0, 3], [1, 0], [1, 2], [1, 2], [0, 1], [0, 0]],
  'and changes no count');

-- A free recipe counting an unlock whose purchase row is gone: a free recipe
-- takes no paid unlock, so that count is a free unlock too.
update public.post_resource_bundles set sales_count = 1
where id = 'f6200001-0000-4000-8000-000000000001';
select is(public.split_post_resource_bundle_free_unlocks(), 1, 'a free recipe''s count past its purchases is split');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200001-0000-4000-8000-000000000001'),
  array[0, 4], 'and becomes a free unlock: a free recipe takes no paid one');

-- Free then paid again, now one free unlock short: the split may not take the
-- difference out of the paid sale.
update public.post_resource_bundles set sales_count = 2, free_unlock_count = 0
where id = 'f6200003-0000-4000-8000-000000000003';
select is(public.split_post_resource_bundle_free_unlocks(), 1, 'a short count is split again');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200003-0000-4000-8000-000000000003'),
  array[1, 1], 'and never into the paid sale');

-- A bundle counting fewer sales than paid purchases stops the split, and what
-- the split had moved before the check is not kept.
update public.post_resource_bundles set sales_count = 0
where id = 'f6200002-0000-4000-8000-000000000002';
update public.post_resource_bundles set sales_count = 2
where id = 'f6200005-0000-4000-8000-000000000005';
select throws_ok(
  'select public.split_post_resource_bundle_free_unlocks()',
  'P0001', 'FREE_UNLOCK_SPLIT_SHORT: 1 bundle(s) count fewer sales than paid purchases',
  'a bundle counting fewer sales than paid purchases stops the split');
select is((select array[sales_count, free_unlock_count] from public.post_resource_bundles where id = 'f6200005-0000-4000-8000-000000000005'),
  array[2, 1], 'and nothing the stopped split moved is kept');

select * from finish();
rollback;

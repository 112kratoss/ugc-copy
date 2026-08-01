-- The buyer's library must show unlocks the creator has since delisted or
-- deleted -- that is the point of it -- while still honouring a moderation
-- take-down and never leaking one buyer's library to another.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('11000000-0000-4000-8000-000000000001'::uuid, 'lib-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('12000000-0000-4000-8000-000000000002'::uuid, 'lib-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('13000000-0000-4000-8000-000000000003'::uuid, 'lib-stranger@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body, title)
values
  ('21000000-0000-4000-8000-000000000001'::uuid, '11000000-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'live post', 'Live post'),
  ('21000000-0000-4000-8000-000000000002'::uuid, '11000000-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'tombstoned post', 'Tombstoned post'),
  ('21000000-0000-4000-8000-000000000003'::uuid, '11000000-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'hidden post', 'Hidden post');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, price_usd_cents
)
select
  ('31000000-0000-4000-8000-00000000000' || suffix)::uuid,
  ('21000000-0000-4000-8000-00000000000' || suffix)::uuid,
  '11000000-0000-4000-8000-000000000001'::uuid,
  'paid', 'published', 'Recipe ' || suffix, 'Summary', 'Preview', 'Prompt', 500
from generate_series(1, 3) AS suffix;

insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
  amount_subunits, currency, status
)
select
  ('41000000-0000-4000-8000-00000000000' || suffix)::uuid,
  ('31000000-0000-4000-8000-00000000000' || suffix)::uuid,
  '12000000-0000-4000-8000-000000000002'::uuid,
  'order_lib_' || suffix, 'pay_lib_' || suffix, 500, 'USD', 'created'
from generate_series(1, 3) AS suffix;

insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
)
select
  ('31000000-0000-4000-8000-00000000000' || suffix)::uuid,
  '12000000-0000-4000-8000-000000000002'::uuid,
  ('41000000-0000-4000-8000-00000000000' || suffix)::uuid,
  500, 500, 'USD'
from generate_series(1, 3) AS suffix;

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  3,
  'the buyer sees every unlock they bought'
);

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '13000000-0000-4000-8000-000000000003'::uuid, 24, 0)),
  0,
  'someone else sees nothing of the buyer library'
);

select is(
  (select total_count::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0) limit 1),
  3,
  'the projection reports the full total alongside the page'
);

-- Tombstone the second post the way the delete service does.
update public.posts
set tombstoned_at = timezone('utc'::text, now()),
    archived_at = timezone('utc'::text, now()),
    visibility = 'private'
where id = '21000000-0000-4000-8000-000000000002'::uuid;

update public.post_resource_bundles
set status = 'draft', retired_at = timezone('utc'::text, now())
where id = '31000000-0000-4000-8000-000000000002'::uuid;

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  3,
  'a tombstoned post stays in the buyer library'
);

select ok(
  (select post_tombstoned from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)
   where post_id = '21000000-0000-4000-8000-000000000002'::uuid),
  'the tombstoned unlock is flagged so the UI can explain it'
);

select ok(
  (select bundle_retired from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)
   where post_id = '21000000-0000-4000-8000-000000000002'::uuid),
  'the retired unlock is flagged too'
);

-- A moderation take-down retracts the unlock for everyone, buyers included.
update public.posts
set review_status = 'hidden'
where id = '21000000-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  2,
  'a moderation take-down drops the unlock out of the library'
);

-- A newer revision is surfaced so the buyer can tell something changed.
update public.post_resource_bundles
set prompt_text = 'Rewritten prompt'
where id = '31000000-0000-4000-8000-000000000001'::uuid;

select ok(
  (select has_newer_revision from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)
   where post_id = '21000000-0000-4000-8000-000000000001'::uuid),
  'an edited bundle is flagged as having a newer version'
);

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 1, 0)),
  1,
  'the projection honours the page limit'
);

select finish();

rollback;

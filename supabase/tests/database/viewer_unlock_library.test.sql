-- The buyer's library must show unlocks the creator has since delisted or
-- deleted -- that is the point of it -- while still honouring a moderation
-- take-down and never leaking one buyer's library to another.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

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
  case when suffix = 2 then 'free' else 'paid' end,
  'published', 'Recipe ' || suffix, 'Summary', 'Preview', 'Prompt',
  case when suffix = 2 then 0 else 500 end
from generate_series(1, 3) AS suffix;

-- Created orders must carry the immutable quote checkout would have pinned;
-- each bundle insert above minted revision 1, so quote against that.
insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
  amount_subunits, currency, status,
  quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media
)
select
  ('41000000-0000-4000-8000-00000000000' || suffix)::uuid,
  ('31000000-0000-4000-8000-00000000000' || suffix)::uuid,
  '12000000-0000-4000-8000-000000000002'::uuid,
  'order_lib_' || suffix, 'pay_lib_' || suffix,
  case when suffix = 2 then 0 else 500 end, 'USD', 'created',
  case when suffix = 2 then 0 else 500 end,
  revisions.id, revisions.content_fingerprint, '[]'::jsonb
from generate_series(1, 3) AS suffix
join lateral (
  select id, content_fingerprint
  from public.post_resource_bundle_revisions
  where bundle_id = ('31000000-0000-4000-8000-00000000000' || suffix)::uuid
  order by revision_number desc
  limit 1
) as revisions on true;

insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
)
select
  ('31000000-0000-4000-8000-00000000000' || suffix)::uuid,
  '12000000-0000-4000-8000-000000000002'::uuid,
  ('41000000-0000-4000-8000-00000000000' || suffix)::uuid,
  case when suffix = 2 then 0 else 500 end,
  case when suffix = 2 then 0 else 500 end,
  'USD'
from generate_series(1, 3) AS suffix;

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  3,
  'the buyer sees every unlock they bought'
);

select is(
  (select count(purchase_id)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  3,
  'every library row exposes its permanent purchase UUID'
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

select isnt(
  (select moderation_retracted_at
   from public.post_resource_bundle_purchases
   where bundle_id = '31000000-0000-4000-8000-000000000003'::uuid),
  null,
  'the moderation retraction is persisted on the purchase'
);

update public.posts
set review_status = 'visible'
where id = '21000000-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  3,
  'restoring the post restores the buyer entitlement'
);

select is(
  (select moderation_retracted_at
   from public.post_resource_bundle_purchases
   where bundle_id = '31000000-0000-4000-8000-000000000003'::uuid),
  null,
  'restoration clears the purchase-level retraction'
);

-- Hide it again so deleting the seller proves the moderation decision cannot
-- disappear with the post that carried it.
update public.posts
set review_status = 'hidden'
where id = '21000000-0000-4000-8000-000000000003'::uuid;

-- Sold content is frozen: the rewrite is refused, so a paid unlock can never
-- dangle a newer version under its buyer.
select throws_ok(
  $$update public.post_resource_bundles
    set prompt_text = 'Rewritten prompt'
    where id = '31000000-0000-4000-8000-000000000001'::uuid$$,
  'RESOURCE_BUNDLE_LOCKED: purchased package content cannot be changed',
  'sold bundle content cannot change under the buyer'
);

select ok(
  not (select has_newer_revision from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)
   where post_id = '21000000-0000-4000-8000-000000000001'::uuid),
  'a frozen purchase never reports a newer version'
);

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 1, 0)),
  1,
  'the projection honours the page limit'
);

delete from auth.users
where id = '11000000-0000-4000-8000-000000000001'::uuid;

select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where buyer_user_id = '12000000-0000-4000-8000-000000000002'::uuid),
  3,
  'paid and free purchases survive seller deletion'
);

select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where buyer_user_id = '12000000-0000-4000-8000-000000000002'::uuid
     and bundle_id is null),
  3,
  'all purchases detach from bundle and post context'
);

select is(
  (select count(*)::int from public.list_viewer_post_resource_unlocks(
    '12000000-0000-4000-8000-000000000002'::uuid, 24, 0)),
  2,
  'the hidden purchase remains retracted after seller deletion'
);

select is(
  (select count(*)::int
   from public.post_resource_bundle_purchases purchases
   where purchases.buyer_user_id = '12000000-0000-4000-8000-000000000002'::uuid
     and purchases.moderation_retracted_at is null
     and exists (
       select 1
       from public.get_viewer_post_resource_unlock(
         purchases.id,
         '12000000-0000-4000-8000-000000000002'::uuid
       )
     )),
  2,
  'multiple detached purchases resolve independently by purchase UUID'
);

select is(
  (select count(*)::int
   from public.get_viewer_post_resource_unlock(
     (select id from public.post_resource_bundle_purchases
      where post_title = 'Hidden post' limit 1),
     '12000000-0000-4000-8000-000000000002'::uuid
   )),
  0,
  'the buyer-scoped detail projection also rejects the moderated purchase'
);

select finish();

rollback;

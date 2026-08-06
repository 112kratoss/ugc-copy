-- Behavioural coverage for "buyers keep what they bought".
--
-- Three invariants, each enforced by a trigger rather than by its callers:
--   * a sale does not mint a revision, and sold content is frozen outright --
--     edits, repricing, retirement, and deletion are explicit conflicts
--   * a purchase pins the revision that was live at checkout, whichever rail
--     inserted it
--   * a post that has been bought can no longer be hard-deleted -- it must be
--     tombstoned -- while account erasure still cascades everything

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(28);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'rev-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('a2000000-0000-4000-8000-000000000002'::uuid, 'rev-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('b0000000-0000-4000-8000-000000000001'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'sold post'),
  ('b0000000-0000-4000-8000-000000000002'::uuid, 'a1000000-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'unsold post');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, price_usd_cents
)
values
  ('c0000000-0000-4000-8000-000000000001'::uuid,
   'b0000000-0000-4000-8000-000000000001'::uuid,
   'a1000000-0000-4000-8000-000000000001'::uuid,
   'paid', 'published', 'Sold recipe', 'A recipe people bought.',
   'Preview of the sold recipe.', 'ORIGINAL PROMPT', 500),
  ('c0000000-0000-4000-8000-000000000002'::uuid,
   'b0000000-0000-4000-8000-000000000002'::uuid,
   'a1000000-0000-4000-8000-000000000001'::uuid,
   'paid', 'published', 'Unsold recipe', 'Nobody bought this one.',
   'Preview of the unsold recipe.', 'UNSOLD PROMPT', 500);

-- 1. Inserting a bundle mints revision 1.
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'creating a bundle captures its first revision'
);

select is(
  (select prompt_text from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid and revision_number = 1),
  'ORIGINAL PROMPT',
  'revision 1 holds the content as published'
);

-- 2. A purchase pins the current revision.
-- Created orders must carry the immutable quote checkout would have pinned.
insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
  amount_subunits, currency, status,
  quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media
)
values (
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'c0000000-0000-4000-8000-000000000001'::uuid,
  'a2000000-0000-4000-8000-000000000002'::uuid,
  'order_rev_1', 'pay_rev_1', 500, 'USD', 'created',
  500,
  (select id from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  (select content_fingerprint from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid
   order by revision_number desc limit 1),
  '[]'::jsonb
);

insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
)
values (
  'c0000000-0000-4000-8000-000000000001'::uuid,
  'a2000000-0000-4000-8000-000000000002'::uuid,
  'd0000000-0000-4000-8000-000000000001'::uuid,
  500, 500, 'USD'
);

select isnt(
  (select revision_id from public.post_resource_bundle_purchases
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  null,
  'a purchase pins a revision without the caller supplying one'
);

select is(
  (select revisions.revision_number
   from public.post_resource_bundle_purchases purchases
   join public.post_resource_bundle_revisions revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the pinned revision is the one that was live at checkout'
);

-- 3. A sale must not mint a revision: sales_count is outside the fingerprint.
update public.post_resource_bundles
set sales_count = sales_count + 1,
    earnings_usd_cents = earnings_usd_cents + 500
where id = 'c0000000-0000-4000-8000-000000000001'::uuid;

select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'recording a sale does not mint a revision'
);

-- 4. Sold content is frozen: the edit is refused and no revision is minted.
select throws_ok(
  $$update public.post_resource_bundles
    set prompt_text = 'GUTTED PROMPT'
    where id = 'c0000000-0000-4000-8000-000000000001'::uuid$$,
  'RESOURCE_BUNDLE_LOCKED: purchased package content cannot be changed',
  'editing sold bundle content is refused outright'
);

select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the refused edit mints no revision'
);

select is(
  (select revisions.prompt_text
   from public.post_resource_bundle_purchases purchases
   join public.post_resource_bundle_revisions revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  'ORIGINAL PROMPT',
  'the buyer still points at what they paid for'
);

-- 5. Repricing and retitling are identity: equally frozen once sold.
select throws_ok(
  $$update public.post_resource_bundles
    set price_usd_cents = 5000, title = 'Renamed recipe'
    where id = 'c0000000-0000-4000-8000-000000000001'::uuid$$,
  'RESOURCE_BUNDLE_LOCKED: purchased package content cannot be changed',
  'repricing a sold bundle is refused'
);

select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the refused repricing mints no revision'
);

select is(
  (select revisions.title
   from public.post_resource_bundle_purchases purchases
   join public.post_resource_bundle_revisions revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  'Sold recipe',
  'the buyer keeps the title they bought'
);

-- 6. Revisions are immutable.
select throws_ok(
  $$update public.post_resource_bundle_revisions
    set prompt_text = 'rewritten history'
    where revision_number = 1
      and bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid$$,
  'Post resource bundle revisions are immutable',
  'a revision cannot be rewritten'
);

-- 7. The buyer-scoped projection.
select is(
  (select revision_number
   from public.get_purchased_post_resource_bundle_revision(
     'c0000000-0000-4000-8000-000000000001'::uuid,
     'a2000000-0000-4000-8000-000000000002'::uuid
   )),
  1,
  'the projection returns the revision the buyer pinned'
);

select ok(
  (select is_latest
   from public.get_purchased_post_resource_bundle_revision(
     'c0000000-0000-4000-8000-000000000001'::uuid,
     'a2000000-0000-4000-8000-000000000002'::uuid
   )),
  'the frozen purchase still points at the latest revision'
);

select is(
  (select count(*)::int
   from public.get_purchased_post_resource_bundle_revision(
     'c0000000-0000-4000-8000-000000000001'::uuid,
     'a1000000-0000-4000-8000-000000000001'::uuid
   )),
  0,
  'the projection returns nothing for someone who did not buy'
);

-- 8. A sold bundle can no longer be deleted or silently retired. Complete the
--    checkout first so the pending-order guard is not what refuses the delete.
update public.post_resource_bundle_orders
set status = 'paid'
where id = 'd0000000-0000-4000-8000-000000000001'::uuid;

select throws_ok(
  $$delete from public.post_resource_bundles
    where id = 'c0000000-0000-4000-8000-000000000001'::uuid$$,
  'RESOURCE_BUNDLE_LOCKED: purchased packages cannot be retired or deleted',
  'deleting a sold bundle is an explicit conflict'
);

select is(
  (select status from public.post_resource_bundles
   where id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  'published',
  'the refused delete leaves the package live'
);

select ok(
  (select retired_at from public.post_resource_bundles
   where id = 'c0000000-0000-4000-8000-000000000001'::uuid) is null,
  'no silent retirement happened'
);

select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where bundle_id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the buyer entitlement survives the refused delete'
);

-- 9. An unsold bundle still deletes normally.
delete from public.post_resource_bundles
where id = 'c0000000-0000-4000-8000-000000000002'::uuid;

select is(
  (select count(*)::int from public.post_resource_bundles
   where id = 'c0000000-0000-4000-8000-000000000002'::uuid),
  0,
  'a bundle nobody bought deletes normally'
);

-- 10. A sold post cannot be hard-deleted.
select throws_ok(
  $$delete from public.posts where id = 'b0000000-0000-4000-8000-000000000001'::uuid$$,
  '23001',
  null,
  'a post with purchased unlocks refuses to be deleted'
);

select is(
  (select count(*)::int from public.posts
   where id = 'b0000000-0000-4000-8000-000000000001'::uuid),
  1,
  'the sold post is still there after the refused delete'
);

-- 11. The guard must not trap a creator inside their own account.
--     posts.user_id cascades from auth.users, so account deletion issues the
--     same DELETE the guard refuses for an ordinary post removal.
delete from auth.users where id = 'a1000000-0000-4000-8000-000000000001'::uuid;

select is(
  (select count(*)::int from public.posts
   where id = 'b0000000-0000-4000-8000-000000000001'::uuid),
  0,
  'deleting the account removes the sold post the guard would otherwise protect'
);

select is(
  (select count(*)::int from public.post_resource_bundles
   where id = 'c0000000-0000-4000-8000-000000000001'::uuid),
  0,
  'the bundle goes with the deleted account rather than being retired forever'
);

-- 12. ...but what the buyer paid for outlives the creator's account entirely.
select is(
  (select count(*)::int from public.post_resource_bundle_purchases
   where buyer_user_id = 'a2000000-0000-4000-8000-000000000002'::uuid),
  1,
  'the purchase survives the creator deleting their account'
);

select is(
  (select revisions.prompt_text
   from public.post_resource_bundle_purchases purchases
   join public.post_resource_bundle_revisions revisions on revisions.id = purchases.revision_id
   where purchases.buyer_user_id = 'a2000000-0000-4000-8000-000000000002'::uuid),
  'ORIGINAL PROMPT',
  'the buyer can still read the revision they paid for'
);

select is(
  (select bundle_id from public.post_resource_bundle_purchases
   where buyer_user_id = 'a2000000-0000-4000-8000-000000000002'::uuid),
  null,
  'the purchase detaches from the deleted bundle instead of cascading away'
);

select is(
  (select seller_display_name is not null or post_title is not null
   from public.post_resource_bundle_purchases
   where buyer_user_id = 'a2000000-0000-4000-8000-000000000002'::uuid),
  true,
  'the purchase kept enough context to render without the creator or post'
);

select finish();

rollback;

-- A recipe's listing status follows its post's exposure, in both directions,
-- for every bundle -- not only sold ones. Studio's visibility menu and
-- restore change exposure without an editor save, so the trigger is the only
-- thing standing between "made public again" and "recipe still a draft".

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('a1000000-0000-4000-8000-00000000e001'::uuid, 'exposure-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('a2000000-0000-4000-8000-00000000e002'::uuid, 'exposure-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('b0000000-0000-4000-8000-00000000e001'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'free recipe post'),
  ('b0000000-0000-4000-8000-00000000e002'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'unsold paid recipe post'),
  ('b0000000-0000-4000-8000-00000000e003'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'sold recipe post');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, price_usd_cents
)
values
  ('c0000000-0000-4000-8000-00000000e001'::uuid,
   'b0000000-0000-4000-8000-00000000e001'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'free', 'published', 'Free recipe', 'Anyone can take this.',
   'Preview of the free recipe.', 'FREE PROMPT', 0),
  ('c0000000-0000-4000-8000-00000000e002'::uuid,
   'b0000000-0000-4000-8000-00000000e002'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'paid', 'published', 'Unsold recipe', 'Nobody has bought this yet.',
   'Preview of the unsold recipe.', 'UNSOLD PROMPT', 500),
  ('c0000000-0000-4000-8000-00000000e003'::uuid,
   'b0000000-0000-4000-8000-00000000e003'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'paid', 'published', 'Sold recipe', 'Someone bought this.',
   'Preview of the sold recipe.', 'SOLD PROMPT', 500);

insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
  amount_subunits, currency, status,
  quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media
)
values (
  'd0000000-0000-4000-8000-00000000e003'::uuid,
  'c0000000-0000-4000-8000-00000000e003'::uuid,
  'a2000000-0000-4000-8000-00000000e002'::uuid,
  'order_exposure_1', 'pay_exposure_1', 500, 'USD', 'created',
  500,
  (select id from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-00000000e003'::uuid
   order by revision_number desc limit 1),
  (select content_fingerprint from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-00000000e003'::uuid
   order by revision_number desc limit 1),
  '[]'::jsonb
);

insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
)
values (
  'c0000000-0000-4000-8000-00000000e003'::uuid,
  'a2000000-0000-4000-8000-00000000e002'::uuid,
  'd0000000-0000-4000-8000-00000000e003'::uuid,
  500, 500, 'USD'
);

-- 1. Leaving public demotes every bundle, as it always did.
update public.posts set visibility = 'private'
where id in (
  'b0000000-0000-4000-8000-00000000e001'::uuid,
  'b0000000-0000-4000-8000-00000000e002'::uuid,
  'b0000000-0000-4000-8000-00000000e003'::uuid
);

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'draft',
  'a free recipe is a draft while its post is private'
);
select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e002'::uuid),
  'draft',
  'an unsold paid recipe is a draft while its post is private'
);
select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e003'::uuid),
  'draft',
  'a sold recipe is a draft while its post is private'
);

-- 2. Returning to public promotes every bundle. Only the sold one came back
--    before; the other two stayed drafts until an editor save.
update public.posts set visibility = 'public'
where id in (
  'b0000000-0000-4000-8000-00000000e001'::uuid,
  'b0000000-0000-4000-8000-00000000e002'::uuid,
  'b0000000-0000-4000-8000-00000000e003'::uuid
);

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'published',
  'a free recipe is published again once its post is public again'
);
select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e002'::uuid),
  'published',
  'an unsold paid recipe is published again once its post is public again'
);
select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e003'::uuid),
  'published',
  'a sold recipe is published again once its post is public again'
);

-- 3. Unlisted is not exposed: the recipe stays a draft.
update public.posts set visibility = 'unlisted'
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'draft',
  'an unlisted post keeps its recipe a draft'
);

update public.posts set visibility = 'public'
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

-- 4. Archiving demotes; restoring promotes. Restore used to clear only
--    archived_at and leave the recipe a draft.
update public.posts set archived_at = timezone('utc'::text, now())
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'draft',
  'archiving a public post demotes its recipe'
);

update public.posts set archived_at = null
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'published',
  'restoring a public post promotes its recipe again'
);

-- 5. Restoring a post that is not public leaves the recipe a draft.
update public.posts set visibility = 'private', archived_at = timezone('utc'::text, now())
where id = 'b0000000-0000-4000-8000-00000000e002'::uuid;
update public.posts set archived_at = null
where id = 'b0000000-0000-4000-8000-00000000e002'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e002'::uuid),
  'draft',
  'restoring a private post does not publish its recipe'
);

-- 6. A status-only sync mints no revision: the content fingerprint is the
--    same, so buyers keep the revision they bought.
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-00000000e003'::uuid),
  1,
  'moving a sold recipe between draft and published mints no revision'
);

-- 7. A write that restates the current visibility still heals a stale draft,
--    the state the old gap left behind.
update public.post_resource_bundles set status = 'draft'
where id = 'c0000000-0000-4000-8000-00000000e001'::uuid;
update public.posts set visibility = 'public'
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'published',
  'restating public visibility heals a recipe left as a draft'
);

-- 8. The old sold-only function and trigger are gone; the new trigger is the
--    one wired to posts.
select hasnt_function(
  'public', 'sync_sold_post_resource_bundle_visibility', array[]::text[],
  'the sold-only sync function is removed'
);
select has_trigger(
  'public', 'posts', 'posts_sync_resource_bundle_exposure',
  'posts carries the exposure sync trigger'
);

select finish();

rollback;

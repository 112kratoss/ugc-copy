-- A recipe's listing status follows its post's exposure, in both directions,
-- for every bundle -- not only sold ones. Studio's visibility menu and
-- restore change exposure without an editor save, so the trigger is the only
-- thing standing between "made public again" and "recipe still a draft".
--
-- Promotion is gated: a sold recipe always comes back (validated when listed,
-- frozen since); any other draft comes back only if it passes the quality
-- predicate a publishing write would apply, so a recipe that was never
-- validated cannot be published by a visibility flip.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('a1000000-0000-4000-8000-00000000e001'::uuid, 'exposure-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('a2000000-0000-4000-8000-00000000e002'::uuid, 'exposure-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles
set username = 'exposureauthor', display_name = 'Exposure Author'
where id = 'a1000000-0000-4000-8000-00000000e001'::uuid;

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values
  ('b0000000-0000-4000-8000-00000000e001'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'Free recipe fixture post', 'A body long enough to read as real public content.'),
  ('b0000000-0000-4000-8000-00000000e002'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'Unsold paid recipe fixture post', 'A body long enough to read as real public content.'),
  ('b0000000-0000-4000-8000-00000000e003'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'public', 'text', 'external', 'text', 'Sold recipe fixture post', 'A body long enough to read as real public content.'),
  ('b0000000-0000-4000-8000-00000000e004'::uuid, 'a1000000-0000-4000-8000-00000000e001'::uuid,
   'private', 'text', 'external', 'text', 'Never validated fixture post', 'A body long enough to read as real public content.');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, price_usd_cents
)
values
  ('c0000000-0000-4000-8000-00000000e001'::uuid,
   'b0000000-0000-4000-8000-00000000e001'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'free', 'published', 'Free recipe', 'Anyone can take this recipe.',
   'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0),
  ('c0000000-0000-4000-8000-00000000e002'::uuid,
   'b0000000-0000-4000-8000-00000000e002'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'paid', 'published', 'Unsold recipe', 'Nobody has bought this one yet.',
   'A preview long enough to satisfy the marketplace quality gate.',
   'A paid prompt that is long enough to count as a real resource.', 500),
  ('c0000000-0000-4000-8000-00000000e003'::uuid,
   'b0000000-0000-4000-8000-00000000e003'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'paid', 'published', 'Sold recipe', 'Someone bought this one already.',
   'A preview long enough to satisfy the marketplace quality gate.',
   'A sold prompt that is long enough to count as a real resource.', 500),
  -- Saved while its post was private: the quality gate never ran. Its prompt
  -- is too short to count as a resource, so it must not be promoted.
  ('c0000000-0000-4000-8000-00000000e004'::uuid,
   'b0000000-0000-4000-8000-00000000e004'::uuid,
   'a1000000-0000-4000-8000-00000000e001'::uuid,
   'free', 'draft', 'Unfinished recipe', 'Still being written, not ready.',
   'A preview long enough to satisfy the marketplace quality gate.',
   'too short', 0);

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

-- 0. The gate helper agrees with the fixtures.
select is(
  public.post_resource_bundle_quality_issue_for('c0000000-0000-4000-8000-00000000e001'::uuid),
  null,
  'the free recipe passes the quality gate'
);
select is(
  public.post_resource_bundle_quality_issue_for('c0000000-0000-4000-8000-00000000e004'::uuid),
  'Attach at least one useful prompt, workflow, file, note, or remix permission.',
  'the unfinished recipe fails the quality gate'
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

-- 2. Returning to public promotes every bundle that passes the gate. Only the
--    sold one came back before; the other two stayed drafts until an editor
--    save.
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

-- 3. A draft that was never validated is not published by a visibility flip.
update public.posts set visibility = 'public'
where id = 'b0000000-0000-4000-8000-00000000e004'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e004'::uuid),
  'draft',
  'a recipe that fails the quality gate stays a draft when its post goes public'
);
select is(
  (select visibility from public.posts where id = 'b0000000-0000-4000-8000-00000000e004'::uuid),
  'public',
  'the post itself still changes visibility'
);

-- 4. Unlisted is not exposed: the recipe stays a draft.
update public.posts set visibility = 'unlisted'
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e001'::uuid),
  'draft',
  'an unlisted post keeps its recipe a draft'
);

update public.posts set visibility = 'public'
where id = 'b0000000-0000-4000-8000-00000000e001'::uuid;

-- 5. Archiving demotes; restoring promotes. Restore used to clear only
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

-- 6. Restoring a post that is not public leaves the recipe a draft.
update public.posts set visibility = 'private', archived_at = timezone('utc'::text, now())
where id = 'b0000000-0000-4000-8000-00000000e002'::uuid;
update public.posts set archived_at = null
where id = 'b0000000-0000-4000-8000-00000000e002'::uuid;

select is(
  (select status from public.post_resource_bundles where id = 'c0000000-0000-4000-8000-00000000e002'::uuid),
  'draft',
  'restoring a private post does not publish its recipe'
);

-- 7. A status-only sync mints no revision: the content fingerprint is the
--    same, so buyers keep the revision they bought.
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'c0000000-0000-4000-8000-00000000e003'::uuid),
  1,
  'moving a sold recipe between draft and published mints no revision'
);

-- 8. A write that restates the current visibility still heals a stale draft,
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

-- 9. The old sold-only function and trigger are gone; the new trigger is the
--    one wired to posts, and the gate helper is backend-only.
select hasnt_function(
  'public', 'sync_sold_post_resource_bundle_visibility', array[]::text[],
  'the sold-only sync function is removed'
);
select has_trigger(
  'public', 'posts', 'posts_sync_resource_bundle_exposure',
  'posts carries the exposure sync trigger'
);
select is(
  has_function_privilege('authenticated', 'public.post_resource_bundle_quality_issue_for(uuid)', 'EXECUTE'),
  false,
  'the quality gate helper is not callable by clients'
);

select finish();

rollback;

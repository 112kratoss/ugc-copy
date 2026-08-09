-- F5b: the derived marketplace listing index.
--
-- Most of this file is about moderation, not performance. Before F5b, post
-- visibility reached the listing through a live join, so a take-down applied
-- the instant it committed. It is now a denormalized boolean, and the whole
-- correctness of that trade rests on the triggers firing. A stale row here is
-- taken-down content still on sale.
--
-- The performance property is asserted too, because it is the reason the
-- trigger uses an explicit column list instead of `OLD.* IS DISTINCT FROM
-- NEW.*`: a hot counter on `posts` must NOT re-evaluate the quality predicate.
-- If someone "simplifies" that WHEN clause, test 11 is what fails.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

-- ─── Fixture ─────────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('0000f5b9-0000-4000-9000-000000000001'::uuid, 'f5b-listings@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles
set username = 'f5blistingseller', display_name = 'F5b Listing Seller'
where id = '0000f5b9-0000-4000-9000-000000000001'::uuid;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
values (
  '0000f5b9-0000-4000-9000-000000000010'::uuid,
  '0000f5b9-0000-4000-9000-000000000001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'visible',
  'A listing fixture post', 'Body text long enough to read as real content.',
  'showcase/f5b-listing.png', 'Nano Banana', 'nano-banana', now(), now()
);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
values (
  '0000f5b9-0000-4000-9000-000000000020'::uuid,
  '0000f5b9-0000-4000-9000-000000000010'::uuid,
  '0000f5b9-0000-4000-9000-000000000001'::uuid,
  'free', 'published',
  'A listing fixture unlock bundle',
  'Summary of the fixture bundle',
  'A preview long enough to satisfy the marketplace quality gate.',
  'The prompt that buyers unlock.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('type', 'prompt', 'title', 'Prompt')),
  '[]'::jsonb,
  0, 0, 0, now(), now()
);

-- ─── The row exists at all ───────────────────────────────────────────────────

select is(
  (select count(*)::bigint from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  1::bigint,
  'inserting a bundle creates its listing row'
);

select ok(
  (select listable from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'a published bundle on a public, visible, unarchived post is listable'
);

select is(
  (select tool_slug from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'nano-banana',
  'the tool slug is denormalized from the post so the listing needs no join'
);

-- ─── Moderation: the take-down path ──────────────────────────────────────────
--
-- This is the assertion the whole design turns on. Note it also asserts the
-- take-down SUCCEEDS: the first implementation stored the gate as a column on
-- post_resource_bundles, so the recompute went through
-- validate_post_resource_bundle_write() and RAISED "Only public posts can
-- publish resource bundles" -- a moderation action that errors rather than a
-- listing that goes stale.

select lives_ok(
  $$update public.posts set review_status = 'hidden'
    where id = '0000f5b9-0000-4000-9000-000000000010'::uuid$$,
  'hiding a post with a published bundle does not raise'
);

select ok(
  NOT (select listable from public.marketplace_bundle_listings
       where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'hiding the post takes its bundle out of the marketplace listing'
);

select is(
  (select count(*)::bigint from public.list_marketplace_resource_bundles('all', 'all', null, null, 'recent', 0, 24)
   where id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  0::bigint,
  'and the listing function actually stops returning it'
);

update public.posts set review_status = 'visible'
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

-- ─── The bundle-side gate ────────────────────────────────────────────────────

update public.post_resource_bundles set title = 'Hi'
where id = '0000f5b9-0000-4000-9000-000000000020'::uuid;

select ok(
  NOT (select listable from public.marketplace_bundle_listings
       where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'a bundle that fails the quality predicate is delisted without any post change'
);

update public.post_resource_bundles set title = 'A listing fixture unlock bundle'
where id = '0000f5b9-0000-4000-9000-000000000020'::uuid;

select ok(
  (select listable from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'un-hiding the post restores the listing'
);

update public.posts set visibility = 'private'
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

select ok(
  NOT (select listable from public.marketplace_bundle_listings
       where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'making the post private takes the bundle out of the listing'
);

update public.posts set visibility = 'public'
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

update public.posts set archived_at = now()
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

select ok(
  NOT (select listable from public.marketplace_bundle_listings
       where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'archiving the post takes the bundle out of the listing'
);

update public.posts set archived_at = null
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

-- ─── The third table the audit did not predict ───────────────────────────────

update public.profiles set username = null, display_name = null
where id = '0000f5b9-0000-4000-9000-000000000001'::uuid;

select ok(
  NOT (select listable from public.marketplace_bundle_listings
       where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  'clearing the seller name delists the bundle -- the quality predicate reads profiles, so this needs a third trigger'
);

update public.profiles set username = 'f5blistingseller', display_name = 'F5b Listing Seller'
where id = '0000f5b9-0000-4000-9000-000000000001'::uuid;

-- ─── The performance guard ───────────────────────────────────────────────────
--
-- `posts` carries save_count, comment_count, share_count and report_count, all
-- written on hot paths. If the WHEN clause is ever widened to
-- `OLD.* IS DISTINCT FROM NEW.*`, every comment re-runs a plpgsql quality
-- predicate for every bundle on that post. Asserted through xmin: a recompute
-- that changes nothing still rewrites the row, so a stable xmin is the only way
-- to show the trigger did not fire at all.

create temporary table f5b_xmin as
select xmin::text as before from public.marketplace_bundle_listings
where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid;

update public.posts set comment_count = comment_count + 1
where id = '0000f5b9-0000-4000-9000-000000000010'::uuid;

select is(
  (select xmin::text from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  (select before from f5b_xmin),
  'a hot counter update on posts does not touch the listing row at all'
);

-- ─── Cascade ─────────────────────────────────────────────────────────────────

delete from public.post_resource_bundles
where id = '0000f5b9-0000-4000-9000-000000000020'::uuid;

select is(
  (select count(*)::bigint from public.marketplace_bundle_listings
   where bundle_id = '0000f5b9-0000-4000-9000-000000000020'::uuid),
  0::bigint,
  'deleting a bundle removes its listing row rather than orphaning a listable one'
);

select * from finish();
rollback;

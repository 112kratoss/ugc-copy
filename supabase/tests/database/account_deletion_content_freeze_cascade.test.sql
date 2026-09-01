-- The content freeze must reject live-owner writes and still let the
-- auth.users erasure cascade through (2026-09-01 production failure: the
-- generations ON DELETE SET NULL answered the auth delete with an UPDATE on
-- the frozen posts row, the freeze raised 55000, and GoTrue rolled the whole
-- account deletion back).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

-- Seller being erased, a buyer who keeps their entitlement, and a second
-- frozen creator proving live-owner freeze semantics are unchanged.
insert into auth.users (
  id, email, aud, role, is_anonymous, created_at,
  raw_app_meta_data, raw_user_meta_data
) values
  ('a1000000-0000-4000-8000-00000000000a'::uuid, 'freeze-seller@example.invalid',
   'authenticated', 'authenticated', false, timezone('utc'::text, now()) - interval '60 days',
   '{}'::jsonb, '{}'::jsonb),
  ('b1000000-0000-4000-8000-00000000000b'::uuid, 'freeze-buyer@example.invalid',
   'authenticated', 'authenticated', false, timezone('utc'::text, now()) - interval '60 days',
   '{}'::jsonb, '{}'::jsonb),
  ('c1000000-0000-4000-8000-00000000000c'::uuid, 'freeze-live@example.invalid',
   'authenticated', 'authenticated', false, timezone('utc'::text, now()) - interval '60 days',
   '{}'::jsonb, '{}'::jsonb);

insert into public.generations (
  id, user_id, model, status, is_public, showcase_asset_path
) values (
  'e1000000-0000-4000-8000-00000000000e'::uuid,
  'a1000000-0000-4000-8000-00000000000a'::uuid,
  'freeze-fixture', 'succeeded', true,
  'showcase/e1000000-0000-4000-8000-00000000000e/seller.webp'
);

-- The post that reproduced production: generation-backed, so the cascade
-- answers the generation delete with UPDATE posts SET generation_id = NULL.
insert into public.posts (
  id, user_id, visibility, category, source_kind, generation_id, title,
  showcase_asset_path
) values
  ('f1000000-0000-4000-8000-00000000000f'::uuid,
   'a1000000-0000-4000-8000-00000000000a'::uuid,
   'public', 'image', 'external',
   'e1000000-0000-4000-8000-00000000000e'::uuid,
   'Seller showcase post',
   'showcase/e1000000-0000-4000-8000-00000000000e/seller.webp'),
  ('f2000000-0000-4000-8000-000000000010'::uuid,
   'c1000000-0000-4000-8000-00000000000c'::uuid,
   'public', 'image', 'external', null,
   'Live-owner post',
   'showcase/f2000000-0000-4000-8000-000000000010/live.webp');

-- Legacy marketplace asset linked from the bundle: its seller cascade answers
-- erasure with UPDATE post_resource_bundles SET legacy_asset_id = NULL, the
-- path that crossed the sold-content and attached-post guards.
insert into public.marketplace_assets (
  id, seller_user_id, post_id, type, title, price_usd_cents, status
) values (
  'a5000000-0000-4000-8000-000000000015'::uuid,
  'a1000000-0000-4000-8000-00000000000a'::uuid,
  'f1000000-0000-4000-8000-00000000000f'::uuid,
  'workflow', 'Legacy workflow', 0, 'active'
);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, legacy_asset_id, access_mode, status,
  title, prompt_text, price_usd_cents
) values (
  'b5000000-0000-4000-8000-000000000016'::uuid,
  'f1000000-0000-4000-8000-00000000000f'::uuid,
  'a1000000-0000-4000-8000-00000000000a'::uuid,
  'a5000000-0000-4000-8000-000000000015'::uuid,
  'paid', 'published', 'Seller pack', 'Reusable prompt', 100
);

-- A real cash purchase makes the bundle "sold", engaging the strictest
-- guard branch during the cascade.
insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, price_usd_cents, amount_subunits, currency
) values (
  'b5000000-0000-4000-8000-000000000016'::uuid,
  'b1000000-0000-4000-8000-00000000000b'::uuid,
  100, 10000, 'INR'
);

-- Walk the seller's deletion job to the stage the production failure was in.
select is(
  public.prepare_account_deletion('a1000000-0000-4000-8000-00000000000a'::uuid) ->> 'status',
  'prepared',
  'seller deletion job prepares'
);
select is(
  public.mark_account_deletion_stage(
    'a1000000-0000-4000-8000-00000000000a'::uuid, 'storage_deleting', null) ->> 'status',
  'storage_deleting',
  'seller job enters storage_deleting'
);
select is(
  public.mark_account_deletion_stage(
    'a1000000-0000-4000-8000-00000000000a'::uuid, 'storage_deleted', null) ->> 'status',
  'storage_deleted',
  'seller job records the storage sweep'
);
select is(
  public.mark_account_deletion_stage(
    'a1000000-0000-4000-8000-00000000000a'::uuid, 'auth_deleting', null) ->> 'status',
  'auth_deleting',
  'seller job enters auth_deleting'
);
select is(
  public.prepare_account_deletion('c1000000-0000-4000-8000-00000000000c'::uuid) ->> 'status',
  'prepared',
  'live-owner deletion job prepares'
);

select is(
  (select count(*)::integer from public.post_resource_bundle_revisions
   where bundle_id = 'b5000000-0000-4000-8000-000000000016'::uuid),
  1,
  'publishing captured one immutable revision'
);
select ok(
  (select revision_id is not null from public.post_resource_bundle_purchases
   where buyer_user_id = 'b1000000-0000-4000-8000-00000000000b'::uuid),
  'the purchase pinned the captured revision'
);

-- Live-owner freeze semantics stay exactly as 20260801150000 wrote them.
select throws_ok(
  $$update public.posts set title = 'Renamed'
    where id = 'f1000000-0000-4000-8000-00000000000f'::uuid$$,
  '55000',
  null,
  'a frozen creator cannot edit a post while deletion is pending'
);
select throws_ok(
  $$insert into public.posts (user_id, visibility, category, source_kind)
    values ('a1000000-0000-4000-8000-00000000000a'::uuid, 'public', 'image', 'external')$$,
  '55000',
  null,
  'a frozen creator cannot publish a new post while deletion is pending'
);
select throws_ok(
  $$update public.post_resource_bundles
    set updated_at = timezone('utc'::text, now())
    where id = 'b5000000-0000-4000-8000-000000000016'::uuid$$,
  '55000',
  null,
  'a frozen creator cannot touch a bundle while deletion is pending'
);
select lives_ok(
  $$update public.posts set review_status = 'hidden'
    where id = 'f2000000-0000-4000-8000-000000000010'::uuid$$,
  'moderation can still change review status on a frozen creator''s post'
);
select throws_ok(
  $$update public.posts set title = 'Still frozen'
    where id = 'f2000000-0000-4000-8000-000000000010'::uuid$$,
  '55000',
  null,
  'non-moderation writes stay frozen for a live owner'
);

-- THE regression: the erasure cascade (generations SET NULL onto the frozen
-- post, marketplace asset SET NULL onto the sold bundle, bundle and post
-- cascade deletes) must run to completion.
select lives_ok(
  $$delete from auth.users where id = 'a1000000-0000-4000-8000-00000000000a'::uuid$$,
  'deleting the auth user succeeds despite frozen generation-backed content'
);

select is(
  (select count(*)::integer from public.posts
   where user_id = 'a1000000-0000-4000-8000-00000000000a'::uuid),
  0,
  'the seller''s posts are erased'
);
select is(
  (select count(*)::integer from public.post_resource_bundles
   where owner_user_id = 'a1000000-0000-4000-8000-00000000000a'::uuid),
  0,
  'the seller''s bundles are erased'
);
select is(
  (select count(*)::integer from public.generations
   where user_id = 'a1000000-0000-4000-8000-00000000000a'::uuid),
  0,
  'the seller''s generations are erased'
);
select is(
  (select count(*)::integer from public.marketplace_assets
   where seller_user_id = 'a1000000-0000-4000-8000-00000000000a'::uuid),
  0,
  'the seller''s marketplace assets are erased'
);
select is(
  (select count(*)::integer from public.post_resource_bundle_revisions
   where bundle_id is null),
  1,
  'the purchased revision survives, detached from the erased bundle'
);
select is(
  (select count(*)::integer from public.post_resource_bundle_purchases
   where buyer_user_id = 'b1000000-0000-4000-8000-00000000000b'::uuid
     and bundle_id is null
     and revision_id is not null),
  1,
  'the buyer keeps a detached purchase pinned to the surviving revision'
);
select is(
  (select status from public.account_deletion_jobs
   where user_id = 'a1000000-0000-4000-8000-00000000000a'::uuid),
  'resweep_waiting',
  'the auth-delete trigger schedules the required delayed storage resweep'
);

select * from finish();
rollback;

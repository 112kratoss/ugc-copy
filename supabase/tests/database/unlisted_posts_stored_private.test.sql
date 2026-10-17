-- a_posts_store_unlisted_as_private: a post is public or private (product
-- decision 12, 2026-10-17). Whoever writes the row, a requested unlisted is
-- stored private, the RPCs answer what they stored, and the triggers that
-- follow a post's exposure see private, not the unlisted asked for.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  'd1200000-0000-4000-8000-00000000d001'::uuid, 'unlisted-owner@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
);

-- 1. A direct insert.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values (
  'd1220000-0000-4000-8000-00000000d001'::uuid, 'd1200000-0000-4000-8000-00000000d001'::uuid,
  'unlisted', 'text', 'external', 'text', 'Inserted unlisted', 'Asked for unlisted on insert.'
);

select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d001'::uuid),
  'private',
  'a post inserted as unlisted is stored private'
);

-- 2. A direct update. The NSFW revision trigger compares the visibility it is
--    given with the stored one; it fires after this one, so a private post
--    asked to go unlisted is no change to it.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values (
  'd1220000-0000-4000-8000-00000000d002'::uuid, 'd1200000-0000-4000-8000-00000000d001'::uuid,
  'private', 'text', 'external', 'text', 'Private note', 'Stored private.'
);

update public.posts set visibility = 'unlisted'
where id = 'd1220000-0000-4000-8000-00000000d002'::uuid;

select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d002'::uuid),
  'private',
  'a post updated to unlisted is stored private'
);
select is(
  (select nsfw_revision from public.posts where id = 'd1220000-0000-4000-8000-00000000d002'::uuid),
  1::bigint,
  'a private post asked to go unlisted keeps its NSFW revision'
);

update public.posts set visibility = 'public'
where id = 'd1220000-0000-4000-8000-00000000d002'::uuid;

select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d002'::uuid),
  'public',
  'public is stored as asked'
);
select is(
  (select nsfw_revision from public.posts where id = 'd1220000-0000-4000-8000-00000000d002'::uuid),
  2::bigint,
  'and a real visibility change still advances the NSFW revision'
);

-- 3. The create RPC, on a new post and on an existing one (ON CONFLICT), as
--    the create and publish services call it.
select is(
  (select (public.upsert_post_with_resource_bundle(
    jsonb_build_object(
      'id', 'd1220000-0000-4000-8000-00000000d003',
      'user_id', 'd1200000-0000-4000-8000-00000000d001',
      'visibility', 'unlisted',
      'category', 'text',
      'post_format', 'text',
      'source_kind', 'external',
      'title', 'Created unlisted',
      'body', 'Asked for unlisted through the create RPC.'
    ),
    null,
    false
  )).visibility),
  'private',
  'the create RPC answers private for a new post asked for as unlisted'
);
select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d003'::uuid),
  'private',
  'and stores it private'
);

update public.posts set visibility = 'public'
where id = 'd1220000-0000-4000-8000-00000000d003'::uuid;

select is(
  (select (public.upsert_post_with_resource_bundle(
    jsonb_build_object(
      'id', 'd1220000-0000-4000-8000-00000000d003',
      'user_id', 'd1200000-0000-4000-8000-00000000d001',
      'visibility', 'unlisted',
      'category', 'text',
      'post_format', 'text',
      'source_kind', 'external',
      'title', 'Created unlisted',
      'body', 'Asked for unlisted through the create RPC.'
    ),
    null,
    false
  )).visibility),
  'private',
  'the create RPC answers private when it rewrites an existing public post as unlisted'
);
select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d003'::uuid),
  'private',
  'and stores it private'
);

-- 4. The update RPC, as the update service calls it.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values (
  'd1220000-0000-4000-8000-00000000d004'::uuid, 'd1200000-0000-4000-8000-00000000d001'::uuid,
  'public', 'text', 'external', 'text', 'Public note', 'Stored public.'
);

select is(
  (select (public.update_post_with_resource_bundle(
    'd1220000-0000-4000-8000-00000000d004'::uuid,
    'd1200000-0000-4000-8000-00000000d001'::uuid,
    '{"visibility": "unlisted"}'::jsonb
  )).visibility),
  'private',
  'the update RPC answers private for a post asked to go unlisted'
);
select is(
  (select visibility from public.posts where id = 'd1220000-0000-4000-8000-00000000d004'::uuid),
  'private',
  'and stores it private'
);

-- 5. The generation behind a post follows what is stored. Unlisted used to
--    keep the generation's public derivative; private drops it, even when the
--    writer hands the generation one, as the old unlisted publish did.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
values (
  'd1210000-0000-4000-8000-00000000d001'::uuid, 'd1200000-0000-4000-8000-00000000d001'::uuid,
  'unlisted-private-1', 'succeeded', 1, 'image', 'test',
  'generated_images/d1200000-0000-4000-8000-00000000d001/one.jpg', false, null
);

select is(
  (select (public.publish_generation_post_with_resource_bundle(
    'd1210000-0000-4000-8000-00000000d001'::uuid,
    'd1200000-0000-4000-8000-00000000d001'::uuid,
    '{"is_public": false, "showcase_asset_path": "showcase/d1210000-0000-4000-8000-00000000d001/one.abc123.jpg"}'::jsonb,
    jsonb_build_object(
      'user_id', 'd1200000-0000-4000-8000-00000000d001',
      'visibility', 'unlisted',
      'category', 'image',
      'post_format', 'media',
      'source_kind', 'magicbooklet',
      'title', 'Generation asked for as unlisted',
      'generation_id', 'd1210000-0000-4000-8000-00000000d001',
      'showcase_asset_path', 'showcase/d1210000-0000-4000-8000-00000000d001/one.abc123.jpg',
      'output_url', 'generated_images/d1200000-0000-4000-8000-00000000d001/one.jpg'
    )
  )).visibility),
  'private',
  'the generation publish RPC answers private for a post asked for as unlisted'
);
select is(
  (select is_public from public.generations where id = 'd1210000-0000-4000-8000-00000000d001'::uuid),
  false,
  'its generation is not public'
);
select is(
  (select showcase_asset_path from public.generations where id = 'd1210000-0000-4000-8000-00000000d001'::uuid),
  null,
  'and keeps no public derivative, as for any private post'
);

-- 6. Shape.
select is(
  (
    select tgname::text
    from pg_trigger
    where tgrelid = 'public.posts'::regclass
      and not tgisinternal
      and (tgtype & 2) = 2   -- BEFORE
      and (tgtype & 64) = 0  -- not INSTEAD OF
    order by tgname
    limit 1
  ),
  'a_posts_store_unlisted_as_private',
  'it is the first BEFORE trigger on posts, so every trigger after it sees the private it stores'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.posts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%visibility%unlisted%'
  ),
  'the visibility CHECK still allows unlisted, so an old value stays legal to read'
);
select is(
  has_function_privilege('authenticated', 'public.store_unlisted_post_as_private()', 'EXECUTE'),
  false,
  'the trigger function is not callable by clients'
);

select finish();

rollback;

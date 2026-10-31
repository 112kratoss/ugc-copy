-- A deleted creation post's cover row names the media the sweeps made from its
-- public copy: preview, display, feed rendition and teaser, all under the
-- creation's folder in the public bucket. The post's delete cascades to its
-- media rows before the posts AFTER DELETE triggers run, so the copy is queued
-- for revocation with them by a BEFORE DELETE trigger that reads the rows
-- first, under the same rule the exposure trigger queues the copy by.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  (
    'dd100000-0000-4000-8000-000000000001'::uuid, 'deleted-post-owner@example.invalid',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  (
    'dd100000-0000-4000-8000-000000000002'::uuid, 'deleted-post-stranger@example.invalid',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  (
    'dd100000-0000-4000-8000-000000000003'::uuid, 'deleted-post-erased@example.invalid',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  );

-- 1 is a live video creation, 2 an image creation deleted below, 3 another
-- account's, 4 removed by an operator, 5 the deleted creation of an account
-- that is erased.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
values
  (
    'dd200000-0000-4000-8000-000000000001'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'deleted-post-1', 'succeeded', 1, 'video', 'test',
    'generated_videos/dd100000-0000-4000-8000-000000000001/one.mp4', true,
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4'
  ),
  (
    'dd200000-0000-4000-8000-000000000002'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'deleted-post-2', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000001/two.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000002/two.abc.jpg'
  ),
  (
    'dd200000-0000-4000-8000-000000000003'::uuid, 'dd100000-0000-4000-8000-000000000002'::uuid,
    'deleted-post-3', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000002/three.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000003/three.abc.jpg'
  ),
  (
    'dd200000-0000-4000-8000-000000000004'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'deleted-post-4', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000001/four.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000004/four.abc.jpg'
  ),
  (
    'dd200000-0000-4000-8000-000000000005'::uuid, 'dd100000-0000-4000-8000-000000000003'::uuid,
    'deleted-post-5', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000003/five.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000005/five.abc.jpg'
  );

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url
)
values
  (
    'dd300000-0000-4000-8000-000000000001'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'video', 'magicbooklet', 'media', 'Live creation',
    'dd200000-0000-4000-8000-000000000001'::uuid,
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4',
    'generated_videos/dd100000-0000-4000-8000-000000000001/one.mp4'
  ),
  (
    'dd300000-0000-4000-8000-000000000002'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Creation since deleted',
    'dd200000-0000-4000-8000-000000000002'::uuid,
    'showcase/dd200000-0000-4000-8000-000000000002/two.abc.jpg',
    'generated_images/dd100000-0000-4000-8000-000000000001/two.jpg'
  ),
  (
    'dd300000-0000-4000-8000-000000000003'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Another account''s creation',
    'dd200000-0000-4000-8000-000000000003'::uuid,
    'showcase/dd200000-0000-4000-8000-000000000003/three.abc.jpg',
    'generated_images/dd100000-0000-4000-8000-000000000002/three.jpg'
  ),
  (
    'dd300000-0000-4000-8000-000000000004'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Removed by an operator',
    'dd200000-0000-4000-8000-000000000004'::uuid,
    'showcase/dd200000-0000-4000-8000-000000000004/four.abc.jpg',
    'generated_images/dd100000-0000-4000-8000-000000000001/four.jpg'
  ),
  (
    'dd300000-0000-4000-8000-000000000005'::uuid, 'dd100000-0000-4000-8000-000000000003'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Erased with its account',
    'dd200000-0000-4000-8000-000000000005'::uuid,
    'showcase/dd200000-0000-4000-8000-000000000005/five.abc.jpg',
    'generated_images/dd100000-0000-4000-8000-000000000003/five.jpg'
  );

-- An uploaded post, linking no creation, whose row names a creation's folder.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, showcase_asset_path)
values (
  'dd300000-0000-4000-8000-000000000006'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
  'public', 'image', 'manual', 'media', 'Uploaded',
  'private-posts/dd300000-0000-4000-8000-000000000006/upload.jpg'
);

-- The cover rows publish gives a creation post, with what the sweeps built.
-- The live creation's post also carries a row outside its folder: an upload of
-- its own (private-posts/<post>/, which post_media_private_cleanup owns) whose
-- preview names another creation's folder.
insert into public.post_media (
  post_id, media_key, storage_path, preview_storage_path, display_storage_path,
  rendition_status, rendition_storage_path, teaser_storage_path, teaser_generated_at,
  media_kind, content_type, original_name, sort_order
)
values
  (
    'dd300000-0000-4000-8000-000000000001'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.preview.p1.webp',
    null,
    'ready', 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.feed.r1.mp4',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.teaser.t1.mp4', now(),
    'video', 'video/mp4', 'one.mp4', 0
  ),
  (
    'dd300000-0000-4000-8000-000000000001'::uuid, 'media-1',
    'private-posts/dd300000-0000-4000-8000-000000000001/upload.jpg',
    'showcase/dd200000-0000-4000-8000-0000000000ff/foreign.preview.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'upload.jpg', 1
  ),
  (
    'dd300000-0000-4000-8000-000000000002'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000002/two.abc.jpg',
    'showcase/dd200000-0000-4000-8000-000000000002/two.abc.preview.p2.webp',
    'showcase/dd200000-0000-4000-8000-000000000002/two.abc.display.d2.webp',
    'skipped', null, null, null,
    'image', 'image/jpeg', 'two.jpg', 0
  ),
  (
    'dd300000-0000-4000-8000-000000000003'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000003/three.abc.jpg',
    'showcase/dd200000-0000-4000-8000-000000000003/three.abc.preview.p3.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'three.jpg', 0
  ),
  (
    'dd300000-0000-4000-8000-000000000004'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000004/four.abc.jpg',
    'showcase/dd200000-0000-4000-8000-000000000004/four.abc.preview.p4.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'four.jpg', 0
  ),
  (
    'dd300000-0000-4000-8000-000000000005'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000005/five.abc.jpg',
    'showcase/dd200000-0000-4000-8000-000000000005/five.abc.preview.p5.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'five.jpg', 0
  ),
  (
    'dd300000-0000-4000-8000-000000000006'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.preview.p6.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'one.jpg', 0
  );

set constraints all immediate;

-- 1. A live creation's post, deleted directly.
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000001'::uuid;

select results_eq(
  $$select post_id, showcase_asset_path, reason
    from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000001'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd300000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.feed.r1.mp4'::text, 'post_deleted'::text),
    ('dd300000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4'::text, 'post_deleted'::text),
    ('dd300000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.preview.p1.webp'::text, 'post_deleted'::text),
    ('dd300000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.teaser.t1.mp4'::text, 'post_deleted'::text)$$,
  'deleting a live creation''s post queues its copy with the preview, rendition and teaser made from it'
);
select is(
  (
    select count(*) from public.posts where id = 'dd300000-0000-4000-8000-000000000001'::uuid
  ) + (
    select count(*) from public.post_media where post_id = 'dd300000-0000-4000-8000-000000000001'::uuid
  ),
  0::bigint,
  'and the delete goes through, with its media rows'
);
select is(
  (
    select count(*) from public.showcase_media_revocations
    where post_id = 'dd300000-0000-4000-8000-000000000001'::uuid
      and generation_id <> 'dd200000-0000-4000-8000-000000000001'::uuid
  ),
  0::bigint,
  'nothing outside the creation''s folder is queued'
);

-- 2. The creation's delete unlinks its post, which records it; the post's own
-- delete then queues under that folder.
delete from public.generations where id = 'dd200000-0000-4000-8000-000000000002'::uuid;
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000002'::uuid;

select results_eq(
  $$select post_id, showcase_asset_path, reason
    from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000002'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd300000-0000-4000-8000-000000000002'::uuid, 'showcase/dd200000-0000-4000-8000-000000000002/two.abc.display.d2.webp'::text, 'post_deleted'::text),
    ('dd300000-0000-4000-8000-000000000002'::uuid, 'showcase/dd200000-0000-4000-8000-000000000002/two.abc.jpg'::text, 'post_deleted'::text),
    ('dd300000-0000-4000-8000-000000000002'::uuid, 'showcase/dd200000-0000-4000-8000-000000000002/two.abc.preview.p2.webp'::text, 'post_deleted'::text)$$,
  'deleting a deleted creation''s post queues its copy with the preview and display, under the creation it recorded'
);

-- 3. What the exposure trigger leaves alone, this leaves alone too.
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*) from public.showcase_media_revocations where generation_id = 'dd200000-0000-4000-8000-000000000003'::uuid),
  0::bigint,
  'another account''s creation is never queued by this account''s post'
);

update public.generations
set moderation_removed_at = now(), is_public = false
where id = 'dd200000-0000-4000-8000-000000000004'::uuid;
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000004'::uuid;

select is(
  (select count(*) from public.showcase_media_revocations where generation_id = 'dd200000-0000-4000-8000-000000000004'::uuid),
  0::bigint,
  'nor a creation an operator removed, whose removal owns its media'
);

delete from public.posts where id = 'dd300000-0000-4000-8000-000000000006'::uuid;

select is(
  (
    select count(*) from public.showcase_media_revocations
    where post_id = 'dd300000-0000-4000-8000-000000000006'::uuid
  ),
  0::bigint,
  'a post that links or recorded no creation queues no folder its rows name'
);

-- 4. Account erasure deletes posts through a cascade, and its own sweep owns
-- that media, a deleted creation's included. (The cascade deletes a live
-- creation before its post, which then names no live creation anyway.) A
-- cascade's BEFORE triggers run a level down, inside it; its AFTER triggers
-- fire with the outer statement, so posts_sync_generation_exposure, at depth
-- 1, still queues the copy itself.
delete from public.generations where id = 'dd200000-0000-4000-8000-000000000005'::uuid;

select is(
  (select deleted_generation_id from public.posts where id = 'dd300000-0000-4000-8000-000000000005'::uuid),
  'dd200000-0000-4000-8000-000000000005'::uuid,
  'the erased account''s post recorded its deleted creation'
);
select lives_ok(
  $$delete from auth.users where id = 'dd100000-0000-4000-8000-000000000003'::uuid$$,
  'the account is erased'
);
select is(
  (select count(*) from public.posts where user_id = 'dd100000-0000-4000-8000-000000000003'::uuid),
  0::bigint,
  'with its posts'
);
select is(
  (
    select count(*) from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000005'::uuid
      and showcase_asset_path <> 'showcase/dd200000-0000-4000-8000-000000000005/five.abc.jpg'
  ),
  0::bigint,
  'and nothing else its media rows name is queued'
);

-- 5. The trigger function is no API.
select ok(
  coalesce(
    not has_function_privilege('anon', to_regprocedure('public.queue_deleted_post_media_revocations()'), 'EXECUTE')
    and not has_function_privilege('authenticated', to_regprocedure('public.queue_deleted_post_media_revocations()'), 'EXECUTE')
    and not has_function_privilege('service_role', to_regprocedure('public.queue_deleted_post_media_revocations()'), 'EXECUTE'),
    false
  ),
  'the trigger function exists and is no API'
);

select finish();

rollback;

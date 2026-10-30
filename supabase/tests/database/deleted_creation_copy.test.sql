-- A post whose creation was deleted keeps serving the creation's copy from the
-- creation's folder (showcase/<generation>/, or private-posts/<generation>/ for
-- one marked NSFW). posts.generation_id is ON DELETE SET NULL, so the post
-- records the creation instead (deleted_generation_id), and every rule that
-- decides which folder is the post's keys on it: the revocation queue, account
-- erasure's manifest, the private media read, the NSFW copy commit and the
-- teaser sweep.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  (
    'dc100000-0000-4000-8000-000000000001'::uuid, 'deleted-creation-owner@example.invalid',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  (
    'dc100000-0000-4000-8000-000000000002'::uuid, 'deleted-creation-viewer@example.invalid',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  );

-- Creations 1 to 6 are deleted below (4 marked NSFW); 7 (marked NSFW), 8 and 9
-- stay. 9 has no post.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
select
  ('dc200000-0000-4000-8000-00000000000' || n)::uuid,
  'dc100000-0000-4000-8000-000000000001'::uuid,
  'deleted-creation-' || n, 'succeeded', 1, 'image', 'test',
  'generated_images/dc100000-0000-4000-8000-000000000001/' || n || '.jpg',
  n not in (4, 7),
  case when n not in (4, 7) then 'showcase/dc200000-0000-4000-8000-00000000000' || n || '/' || n || '.abc.jpg' end
from generate_series(1, 9) as n;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url, is_nsfw
)
select
  ('dc300000-0000-4000-8000-00000000000' || n)::uuid,
  'dc100000-0000-4000-8000-000000000001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'Creation ' || n,
  ('dc200000-0000-4000-8000-00000000000' || n)::uuid,
  case when n in (4, 7)
    then 'private-posts/dc200000-0000-4000-8000-00000000000' || n || '/' || n || '.abc.jpg'
    else 'showcase/dc200000-0000-4000-8000-00000000000' || n || '/' || n || '.abc.jpg'
  end,
  'generated_images/dc100000-0000-4000-8000-000000000001/' || n || '.jpg',
  n in (4, 7)
from generate_series(1, 8) as n;

-- The cover row publish gives a creation post, with a preview the sweep built.
insert into public.post_media (
  post_id, media_key, storage_path, preview_storage_path, media_kind, content_type, original_name, sort_order
)
values (
  'dc300000-0000-4000-8000-000000000006'::uuid, 'media-0',
  'showcase/dc200000-0000-4000-8000-000000000006/6.abc.jpg',
  'showcase/dc200000-0000-4000-8000-000000000006/6.abc.preview.123.webp',
  'image', 'image/jpeg', '6.jpg', 0
);

set constraints all immediate;

-- 1. The creation's delete unlinks the post, which keeps serving the copy.
delete from public.generations
where id in (
  'dc200000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000002',
  'dc200000-0000-4000-8000-000000000003', 'dc200000-0000-4000-8000-000000000004',
  'dc200000-0000-4000-8000-000000000005', 'dc200000-0000-4000-8000-000000000006'
);

select is(
  (select generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000001'::uuid),
  null,
  'deleting a creation unlinks its post'
);
select is(
  (select showcase_asset_path from public.posts where id = 'dc300000-0000-4000-8000-000000000001'::uuid),
  'showcase/dc200000-0000-4000-8000-000000000001/1.abc.jpg',
  'and the post keeps serving the creation''s copy'
);
select is(
  (select count(*) from public.showcase_media_revocations where generation_id::text like 'dc200000-%'),
  0::bigint,
  'so nothing is queued for revocation by the delete'
);
select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000001'::uuid),
  'dc200000-0000-4000-8000-000000000001'::uuid,
  'the post records the deleted creation whose folder it keeps'
);

-- 2. Made private through the update RPC, the way post-update-service does it.
select public.update_post_with_resource_bundle(
  'dc300000-0000-4000-8000-000000000001'::uuid,
  'dc100000-0000-4000-8000-000000000001'::uuid,
  '{"visibility": "private", "showcase_asset_path": null}'::jsonb
);

select results_eq(
  $$select generation_id, post_id, showcase_asset_path, reason
    from public.showcase_media_revocations
    where generation_id = 'dc200000-0000-4000-8000-000000000001'::uuid$$,
  $$values (
    'dc200000-0000-4000-8000-000000000001'::uuid,
    'dc300000-0000-4000-8000-000000000001'::uuid,
    'showcase/dc200000-0000-4000-8000-000000000001/1.abc.jpg'::text,
    'post_unexposed'::text
  )$$,
  'a post made private queues the deleted creation''s copy under its folder'
);

-- 3. A direct delete.
delete from public.posts where id = 'dc300000-0000-4000-8000-000000000002'::uuid;

select results_eq(
  $$select post_id, showcase_asset_path, reason
    from public.showcase_media_revocations
    where generation_id = 'dc200000-0000-4000-8000-000000000002'::uuid$$,
  $$values (
    'dc300000-0000-4000-8000-000000000002'::uuid,
    'showcase/dc200000-0000-4000-8000-000000000002/2.abc.jpg'::text,
    'post_deleted'::text
  )$$,
  'deleting the post queues the copy it left behind'
);

-- 4. Archive keeps the copy for restore, as for a live creation.
update public.posts
set archived_at = now(), archived_by_user_id = 'dc100000-0000-4000-8000-000000000001'::uuid
where id = 'dc300000-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*) from public.showcase_media_revocations where generation_id = 'dc200000-0000-4000-8000-000000000003'::uuid),
  0::bigint,
  'an archived post''s copy is not queued'
);

-- 5. The NSFW copy of a deleted creation stays readable by its owner, and is
-- still behind the warning for anyone else.
select ok(
  public.can_read_private_post_media(
    'private-posts/dc200000-0000-4000-8000-000000000004/4.abc.jpg',
    'dc100000-0000-4000-8000-000000000001'::uuid
  ),
  'the owner reads the private copy of a deleted creation marked NSFW'
);
select ok(
  not public.can_read_private_post_media(
    'private-posts/dc200000-0000-4000-8000-000000000004/4.abc.jpg',
    'dc100000-0000-4000-8000-000000000002'::uuid
  ),
  'another viewer still needs the reveal'
);
select ok(
  not public.can_read_private_post_media(
    'private-posts/dc200000-0000-4000-8000-000000000009/9.abc.jpg',
    'dc100000-0000-4000-8000-000000000001'::uuid
  ),
  'a folder no post names stays unreadable'
);

-- 6. Marking it NSFW moves the copy out of the public bucket.
insert into storage.objects (bucket_id, name, metadata)
values
  ('showcase_media', 'showcase/dc200000-0000-4000-8000-000000000005/5.abc.jpg', '{"size": 100}'::jsonb),
  ('post_media', 'private-posts/dc300000-0000-4000-8000-000000000005/0123456789abcdef-5.abc.jpg', '{"size": 100}'::jsonb);

select lives_ok(
  $$select public.commit_nsfw_media_private_copy(
    'dc300000-0000-4000-8000-000000000005'::uuid,
    'dc100000-0000-4000-8000-000000000001'::uuid,
    'showcase/dc200000-0000-4000-8000-000000000005/5.abc.jpg',
    'private-posts/dc300000-0000-4000-8000-000000000005/0123456789abcdef-5.abc.jpg'
  )$$,
  'the private copy of a deleted creation''s public copy commits'
);
select is(
  (select showcase_asset_path from public.posts where id = 'dc300000-0000-4000-8000-000000000005'::uuid),
  'private-posts/dc300000-0000-4000-8000-000000000005/0123456789abcdef-5.abc.jpg',
  'and the post serves the private copy'
);
select throws_ok(
  $$select public.commit_nsfw_media_private_copy(
    'dc300000-0000-4000-8000-000000000005'::uuid,
    'dc100000-0000-4000-8000-000000000001'::uuid,
    'showcase/dc200000-0000-4000-8000-000000000008/8.abc.jpg',
    'private-posts/dc300000-0000-4000-8000-000000000005/fedcba9876543210-8.abc.jpg'
  )$$,
  'P0001',
  'Invalid post media membership',
  'another creation''s folder is still refused'
);

-- 7. The column follows the link alone.
update public.posts
set deleted_generation_id = 'dc200000-0000-4000-8000-000000000008'::uuid
where id = 'dc300000-0000-4000-8000-000000000003'::uuid;

select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000003'::uuid),
  'dc200000-0000-4000-8000-000000000003'::uuid,
  'a write cannot point an unlinked post at another creation'
);

update public.posts
set deleted_generation_id = 'dc200000-0000-4000-8000-000000000003'::uuid
where id = 'dc300000-0000-4000-8000-000000000008'::uuid;

select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000008'::uuid),
  null,
  'nor give a linked post one'
);

-- An uploaded post naming another post's deleted creation in its path.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title, showcase_asset_path, deleted_generation_id
)
values (
  'dc300000-0000-4000-8000-000000000009'::uuid, 'dc100000-0000-4000-8000-000000000001'::uuid,
  'public', 'image', 'manual', 'media', 'Uploaded',
  'showcase/dc200000-0000-4000-8000-000000000001/1.abc.jpg',
  'dc200000-0000-4000-8000-000000000001'::uuid
);

select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000009'::uuid),
  null,
  'nor a new post'
);

-- An unlink that is not the creation's delete leaves the creation its folder.
update public.posts set generation_id = null where id = 'dc300000-0000-4000-8000-000000000008'::uuid;

select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000008'::uuid),
  null,
  'unlinking a creation that still exists records nothing'
);

-- Linking a live creation takes over from the deleted one.
update public.posts
set generation_id = 'dc200000-0000-4000-8000-000000000009'::uuid
where id = 'dc300000-0000-4000-8000-000000000003'::uuid;

select is(
  (select deleted_generation_id from public.posts where id = 'dc300000-0000-4000-8000-000000000003'::uuid),
  null,
  'a post linked to a live creation names no deleted one'
);

alter table public.posts disable trigger posts_record_deleted_generation;
select throws_ok(
  $$update public.posts
    set deleted_generation_id = 'dc200000-0000-4000-8000-000000000001'::uuid
    where id = 'dc300000-0000-4000-8000-000000000003'::uuid$$,
  '23514',
  null,
  'a post never links a creation and names a deleted one at once'
);
alter table public.posts enable trigger posts_record_deleted_generation;

select ok(
  not has_function_privilege('anon', 'public.record_deleted_post_generation()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_deleted_post_generation()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.record_deleted_post_generation()', 'EXECUTE'),
  'the trigger function is no API'
);

-- A deleted creation's post keeps that creation's media, as a linked one does.
select throws_ok(
  $$select public.replace_post_media(
    'dc300000-0000-4000-8000-000000000001'::uuid,
    'dc100000-0000-4000-8000-000000000001'::uuid,
    '[]'::jsonb
  )$$,
  'P0001',
  'Manual post not found or media is not editable.',
  'its media cannot be replaced'
);

-- 8. The teaser sweep admits the rendition of a deleted creation's post.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
values (
  'dc200000-0000-4000-8000-00000000000a'::uuid, 'dc100000-0000-4000-8000-000000000001'::uuid,
  'deleted-creation-a', 'succeeded', 1, 'video', 'test',
  'generated_videos/dc100000-0000-4000-8000-000000000001/a.mp4', true,
  'showcase/dc200000-0000-4000-8000-00000000000a/a.abc.mp4'
);
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title, generation_id, showcase_asset_path, output_url
)
values (
  'dc300000-0000-4000-8000-00000000000a'::uuid, 'dc100000-0000-4000-8000-000000000001'::uuid,
  'public', 'video', 'magicbooklet', 'media', 'Creation a',
  'dc200000-0000-4000-8000-00000000000a'::uuid,
  'showcase/dc200000-0000-4000-8000-00000000000a/a.abc.mp4',
  'generated_videos/dc100000-0000-4000-8000-000000000001/a.mp4'
);
insert into public.post_media (
  post_id, media_key, storage_path, media_kind, content_type, original_name, sort_order,
  rendition_status, rendition_storage_path, duration_seconds
)
values (
  'dc300000-0000-4000-8000-00000000000a'::uuid, 'media-0',
  'showcase/dc200000-0000-4000-8000-00000000000a/a.abc.mp4', 'video', 'video/mp4', 'a.mp4', 0,
  'ready', 'showcase/dc200000-0000-4000-8000-00000000000a/a.abc.feed.1.mp4', 37.5
);
insert into storage.objects (bucket_id, name, metadata)
values ('showcase_media', 'showcase/dc200000-0000-4000-8000-00000000000a/a.abc.feed.1.mp4', '{"size": 2048}'::jsonb);
delete from public.generations where id = 'dc200000-0000-4000-8000-00000000000a'::uuid;

create temporary table deleted_creation_teaser as
select * from public.claim_post_media_teaser_repair('worker-deleted-creation');

select results_eq(
  $$select post_id, generation_id from deleted_creation_teaser$$,
  $$values ('dc300000-0000-4000-8000-00000000000a'::uuid, 'dc200000-0000-4000-8000-00000000000a'::uuid)$$,
  'the teaser sweep admits a rendition under the deleted creation''s prefix, naming that creation for the worker''s check'
);

-- 9. Account erasure deletes the copy with the account. Last: it marks the
-- owner as deleting, which closes their private media reads.
create temporary table deleted_creation_erasure as
select public.prepare_account_deletion('dc100000-0000-4000-8000-000000000001'::uuid)
  -> 'storage_manifest' -> 'showcase_media_paths' as paths;

select ok(
  (select paths ? 'showcase/dc200000-0000-4000-8000-000000000006/6.abc.jpg' from deleted_creation_erasure),
  'the erasure manifest lists the deleted creation''s copy'
);
select ok(
  (select paths ? 'showcase/dc200000-0000-4000-8000-000000000006/6.abc.preview.123.webp' from deleted_creation_erasure),
  'and the media made from it'
);
select ok(
  (select paths ? 'private-posts/dc200000-0000-4000-8000-000000000004/4.abc.jpg' from deleted_creation_erasure),
  'the private copy of a deleted creation marked NSFW'
);
select ok(
  (select paths ? 'private-posts/dc200000-0000-4000-8000-000000000007/7.abc.jpg' from deleted_creation_erasure),
  'and of a live creation marked NSFW'
);
select ok(
  not (select paths ? 'showcase/dc200000-0000-4000-8000-000000000001/1.abc.jpg' from deleted_creation_erasure),
  'never a creation''s folder named by a post that did not record it'
);

select finish();

rollback;

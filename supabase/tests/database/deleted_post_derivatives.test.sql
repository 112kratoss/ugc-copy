-- A deleted creation post's cover row names the media the sweeps made from its
-- public copy: preview, display, feed rendition and teaser, all under the
-- creation's folder in the public bucket. The post's delete cascades to its
-- media rows before the posts AFTER DELETE triggers run, so a BEFORE DELETE
-- trigger reads the rows first and queues what they name for revocation: for a
-- live creation the post's owner made (or a guest linked to them), whatever an
-- operator did to it, or for the deleted creation the post recorded. Account
-- erasure's cascade is left to the erasure's sweep.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

insert into auth.users (id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at)
values
  (
    'dd100000-0000-4000-8000-000000000001'::uuid, 'deleted-post-owner@example.invalid',
    'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  (
    'dd100000-0000-4000-8000-000000000002'::uuid, 'deleted-post-stranger@example.invalid',
    'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  (
    'dd100000-0000-4000-8000-000000000003'::uuid, 'deleted-post-erased@example.invalid',
    'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
  ),
  -- A guest that made a creation and then registered as the owner.
  (
    'dd100000-0000-4000-8000-000000000004'::uuid, null,
    'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb, now()
  );

select public.merge_guest_account(
  'dd100000-0000-4000-8000-000000000004'::uuid,
  'dd100000-0000-4000-8000-000000000001'::uuid,
  'mobile'
);

-- 1 is a live video creation, 2 an image creation deleted below, 3 another
-- account's, 4 removed by an operator, 5 the deleted creation of an account
-- that is erased, 6 made by the guest, 7 deleted from inside another trigger.
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
  ),
  (
    'dd200000-0000-4000-8000-000000000006'::uuid, 'dd100000-0000-4000-8000-000000000004'::uuid,
    'deleted-post-6', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000004/six.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000006/six.abc.jpg'
  ),
  (
    'dd200000-0000-4000-8000-000000000007'::uuid, 'dd100000-0000-4000-8000-000000000001'::uuid,
    'deleted-post-7', 'succeeded', 1, 'image', 'test',
    'generated_images/dd100000-0000-4000-8000-000000000001/seven.jpg', true,
    'showcase/dd200000-0000-4000-8000-000000000007/seven.abc.jpg'
  );

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url
)
select
  ('dd300000-0000-4000-8000-00000000000' || n)::uuid,
  case n when 5 then 'dd100000-0000-4000-8000-000000000003' else 'dd100000-0000-4000-8000-000000000001' end::uuid,
  'public', case n when 1 then 'video' else 'image' end, 'magicbooklet', 'media', 'Creation ' || n,
  ('dd200000-0000-4000-8000-00000000000' || g)::uuid,
  'showcase/dd200000-0000-4000-8000-00000000000' || g || '/' || name || '.abc.' || extension,
  'generated_' || case n when 1 then 'videos' else 'images' end || '/x/' || name || '.' || extension
from (values
  (1, 1, 'one', 'mp4'), (2, 2, 'two', 'jpg'), (3, 3, 'three', 'jpg'), (4, 4, 'four', 'jpg'),
  (5, 5, 'five', 'jpg'), (7, 6, 'six', 'jpg'), (8, 7, 'seven', 'jpg')
) as fixture(n, g, name, extension);

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
    'dd300000-0000-4000-8000-000000000006'::uuid, 'media-0',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4',
    'showcase/dd200000-0000-4000-8000-000000000001/one.abc.preview.p6.webp',
    null, 'skipped', null, null, null,
    'image', 'image/jpeg', 'one.jpg', 0
  );

-- Posts 3, 4, 5, 7 and 8 get a cover row with a preview.
insert into public.post_media (
  post_id, media_key, storage_path, preview_storage_path, rendition_status,
  media_kind, content_type, original_name, sort_order
)
select
  ('dd300000-0000-4000-8000-00000000000' || n)::uuid, 'media-0',
  'showcase/dd200000-0000-4000-8000-00000000000' || g || '/' || name || '.abc.jpg',
  'showcase/dd200000-0000-4000-8000-00000000000' || g || '/' || name || '.abc.preview.p' || n || '.webp',
  'skipped', 'image', 'image/jpeg', name || '.jpg', 0
from (values (3, 3, 'three'), (4, 4, 'four'), (5, 5, 'five'), (7, 6, 'six'), (8, 7, 'seven')) as fixture(n, g, name);

set constraints all immediate;

-- 1. A live creation's post, deleted directly.
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000001'::uuid;

select results_eq(
  $$select generation_id, showcase_asset_path, reason
    from public.showcase_media_revocations
    where post_id = 'dd300000-0000-4000-8000-000000000001'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd200000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.feed.r1.mp4'::text, 'post_deleted'::text),
    ('dd200000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.mp4'::text, 'post_deleted'::text),
    ('dd200000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.preview.p1.webp'::text, 'post_deleted'::text),
    ('dd200000-0000-4000-8000-000000000001'::uuid, 'showcase/dd200000-0000-4000-8000-000000000001/one.abc.teaser.t1.mp4'::text, 'post_deleted'::text)$$,
  'deleting a live creation''s post queues its copy with the preview, rendition and teaser made from it, and nothing outside its folder'
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

-- 3. Another account's creation, linked by this account's post.
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000003'::uuid;

select is(
  (select count(*) from public.showcase_media_revocations where generation_id = 'dd200000-0000-4000-8000-000000000003'::uuid),
  0::bigint,
  'another account''s creation is never queued by this account''s post'
);

-- 4. An operator's removal only hides the creation: its storage stays, and the
-- revocation job keeps whatever the creation still names (the copy, for a
-- restore). The deleted post's media is queued as for any other.
update public.generations
set moderation_removed_at = now(), is_public = false
where id = 'dd200000-0000-4000-8000-000000000004'::uuid;
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000004'::uuid;

select results_eq(
  $$select post_id, showcase_asset_path
    from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000004'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd300000-0000-4000-8000-000000000004'::uuid, 'showcase/dd200000-0000-4000-8000-000000000004/four.abc.jpg'::text),
    ('dd300000-0000-4000-8000-000000000004'::uuid, 'showcase/dd200000-0000-4000-8000-000000000004/four.abc.preview.p4.webp'::text)$$,
  'a creation an operator removed still has its deleted post''s media queued'
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

-- 5. A creation made as a guest, posted by the account the guest registered as.
delete from public.posts where id = 'dd300000-0000-4000-8000-000000000007'::uuid;

select results_eq(
  $$select post_id, showcase_asset_path
    from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000006'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd300000-0000-4000-8000-000000000007'::uuid, 'showcase/dd200000-0000-4000-8000-000000000006/six.abc.jpg'::text),
    ('dd300000-0000-4000-8000-000000000007'::uuid, 'showcase/dd200000-0000-4000-8000-000000000006/six.abc.preview.p7.webp'::text)$$,
  'a creation the owner made as a guest is queued like their own'
);

-- 6. A delete issued from inside another trigger is still a direct delete:
-- only account erasure's cascade is left to its sweep.
create temporary table nested_post_delete (post_id uuid);
create function pg_temp.delete_post_inside_trigger() returns trigger language plpgsql as $$
begin
  delete from public.posts where id = new.post_id;
  return new;
end;
$$;
create trigger nested_post_delete after insert on nested_post_delete
  for each row execute function pg_temp.delete_post_inside_trigger();
insert into nested_post_delete values ('dd300000-0000-4000-8000-000000000008'::uuid);

select results_eq(
  $$select post_id, showcase_asset_path
    from public.showcase_media_revocations
    where generation_id = 'dd200000-0000-4000-8000-000000000007'::uuid
    order by showcase_asset_path$$,
  $$values
    ('dd300000-0000-4000-8000-000000000008'::uuid, 'showcase/dd200000-0000-4000-8000-000000000007/seven.abc.jpg'::text),
    ('dd300000-0000-4000-8000-000000000008'::uuid, 'showcase/dd200000-0000-4000-8000-000000000007/seven.abc.preview.p8.webp'::text)$$,
  'a post deleted from inside another trigger is queued like any direct delete'
);

-- 7. Account erasure deletes posts through the cascade from auth.users, and
-- its own sweep owns that media, a deleted creation's included. (The cascade
-- deletes a live creation before its post, which then names no live creation
-- anyway.) The cascade's AFTER triggers fire with the outer statement, so
-- posts_sync_generation_exposure, at depth 1, still queues the copy itself.
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

-- 8. The trigger function is no API.
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

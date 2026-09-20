begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);
select is((select public from storage.buckets where id = 'post_media'), false, 'uploaded originals and derivatives are private');
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('a9100000-0000-4000-8000-000000000001','media-owner@example.invalid','authenticated','authenticated','{}','{}', now()),
       ('a9200000-0000-4000-8000-000000000002','media-viewer@example.invalid','authenticated','authenticated','{}','{}', now());
insert into public.posts (id,user_id,visibility,category,source_kind,post_format,showcase_asset_path)
values ('b9100000-0000-4000-8000-000000000001','a9100000-0000-4000-8000-000000000001','private','image','manual','media',
        'private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg');
insert into public.post_media (post_id, storage_path, preview_storage_path, media_kind, sort_order)
values ('b9100000-0000-4000-8000-000000000001',
        'private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg',
        'private-posts/b9100000-0000-4000-8000-000000000001/photo.preview.webp', 'image', 0);
select ok(public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg','a9100000-0000-4000-8000-000000000001'), 'owner can read private original');
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg',null), 'anonymous cannot read private');
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg','a9200000-0000-4000-8000-000000000002'), 'other user cannot read private');
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/orphan.jpg','a9100000-0000-4000-8000-000000000001'), 'prefix alone does not authorize an orphan');
update public.posts set visibility='public' where id='b9100000-0000-4000-8000-000000000001';
select ok(public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.preview.webp',null), 'public derivative serves signed out');
update public.posts set archived_at=now() where id='b9100000-0000-4000-8000-000000000001';
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg',null), 'archive immediately prevents new signatures');
update public.posts set archived_at=null,review_status='hidden' where id='b9100000-0000-4000-8000-000000000001';
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg',null), 'moderation prevents new public signatures');
update public.posts set review_status='visible' where id='b9100000-0000-4000-8000-000000000001';
insert into public.user_blocks(blocker_user_id,blocked_user_id) values ('a9100000-0000-4000-8000-000000000001','a9200000-0000-4000-8000-000000000002');
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg','a9200000-0000-4000-8000-000000000002'), 'block prevents signed-in read');
select ok(not has_function_privilege('anon','public.can_read_private_post_media(text,uuid)','execute'), 'anon cannot impersonate a viewer');
select ok(not has_function_privilege('authenticated','public.can_read_private_post_media(text,uuid)','execute'), 'authenticated cannot impersonate a viewer');
select ok(has_function_privilege('service_role','public.can_read_private_post_media(text,uuid)','execute'), 'backend may authorize');
select ok((public.prepare_account_deletion('a9100000-0000-4000-8000-000000000001')->'storage_manifest'->'showcase_media_paths') ? 'private-posts/b9100000-0000-4000-8000-000000000001/photo.preview.webp','deletion manifest retains private derivatives');
select ok(not public.can_read_private_post_media('private-posts/b9100000-0000-4000-8000-000000000001/photo.jpg',null),'deleting identity cannot expose media');
select * from finish();
rollback;

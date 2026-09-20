begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(10);
insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,created_at) values
('a9300000-0000-4000-8000-000000000001','copy-owner@example.invalid','authenticated','authenticated','{}','{}',now()),
('a9400000-0000-4000-8000-000000000001','copy-buyer@example.invalid','authenticated','authenticated','{}','{}',now());
insert into public.posts(id,user_id,visibility,category,source_kind,post_format,showcase_asset_path) values
('b9300000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001','private','image','manual','media','posts/b9300000-0000-4000-8000-000000000001/photo.jpg');
insert into public.post_media(post_id,storage_path,media_kind,sort_order) values
('b9300000-0000-4000-8000-000000000001','posts/b9300000-0000-4000-8000-000000000001/photo.jpg','image',0);
insert into storage.objects(bucket_id,name,metadata) values
('showcase_media','posts/b9300000-0000-4000-8000-000000000001/photo.jpg','{"size":100}');
select throws_ok($$select public.commit_uploaded_media_private_copy('posts/b9300000-0000-4000-8000-000000000001/photo.jpg')$$,'P0001','Private copy has not been verified','cannot repoint metadata before a copy exists');
insert into storage.objects(bucket_id,name,metadata) values
('post_media','private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg','{"size":100}');
select lives_ok($$select public.commit_uploaded_media_private_copy('posts/b9300000-0000-4000-8000-000000000001/photo.jpg')$$,'commits verified copy');
select is((select storage_path from public.post_media where post_id='b9300000-0000-4000-8000-000000000001'),'private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg','live gallery uses private namespace');
select is((select showcase_asset_path from public.posts where id='b9300000-0000-4000-8000-000000000001'),'private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg','legacy cover follows gallery');
select lives_ok($$select public.commit_uploaded_media_private_copy('posts/b9300000-0000-4000-8000-000000000001/photo.jpg')$$,'replay is idempotent');
select ok(exists(select 1 from public.uploaded_media_private_copies where revoked_at is null),'revocation remains durable after metadata commit');
-- Detached snapshots are a supported database state after creator deletion.
insert into public.post_resource_bundle_purchases(id,buyer_user_id,price_usd_cents,amount_subunits,currency) values
('c9400000-0000-4000-8000-000000000001','a9400000-0000-4000-8000-000000000001',0,0,'USD');
insert into public.post_resource_purchase_media(purchase_id,media_key,storage_path,media_kind,sort_order) values
('c9400000-0000-4000-8000-000000000001','proof','posts/b9300000-0000-4000-8000-000000000001/photo.jpg','image',0);
select is(public.resolve_post_media_read('posts/b9300000-0000-4000-8000-000000000001/photo.jpg','a9400000-0000-4000-8000-000000000001'),'private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg','immutable purchase alias resolves private copy');
select ok(public.private_post_media_is_referenced('private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg'),'cleanup retains pinned media');
update public.post_resource_bundle_purchases set moderation_retracted_at=now() where id='c9400000-0000-4000-8000-000000000001';
select is(public.resolve_post_media_read('posts/b9300000-0000-4000-8000-000000000001/photo.jpg','a9400000-0000-4000-8000-000000000001'),null,'moderation retracts aliased purchase capability');
delete from public.post_media where post_id='b9300000-0000-4000-8000-000000000001';
select ok(exists(select 1 from public.post_media_object_cleanup where storage_path='private-posts/b9300000-0000-4000-8000-000000000001/photo.jpg'),'gallery deletion queues cleanup in the transaction');
select * from finish();
rollback;

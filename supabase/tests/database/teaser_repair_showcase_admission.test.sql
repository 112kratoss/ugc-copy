begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('e7100000-0000-4000-8000-000000000001', 'teaser-showcase@example.invalid', 'authenticated', 'authenticated', '{}', '{}');
-- Every NOT NULL column on generations carries a default, so an id is enough.
insert into public.generations (id, user_id)
values ('e7200000-0000-4000-8000-000000000001', 'e7100000-0000-4000-8000-000000000001'),
       ('e7200000-0000-4000-8000-000000000002', 'e7100000-0000-4000-8000-000000000001');
-- Post 1 was published from generation 1 and keeps its rendition under that
-- generation's showcase prefix. Post 2 links generation 2 but its rendition
-- sits under generation 1's prefix: owned by a generation, just not its own.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path, generation_id)
values ('e7300000-0000-4000-8000-000000000001', 'e7100000-0000-4000-8000-000000000001', 'public', 'video', 'magicbooklet', 'media',
        'showcase/e7200000-0000-4000-8000-000000000001/clip.mp4', 'e7200000-0000-4000-8000-000000000001'),
       ('e7300000-0000-4000-8000-000000000002', 'e7100000-0000-4000-8000-000000000001', 'public', 'video', 'magicbooklet', 'media',
        'showcase/e7200000-0000-4000-8000-000000000002/clip.mp4', 'e7200000-0000-4000-8000-000000000002');
insert into public.post_media (id, post_id, storage_path, media_kind, sort_order, rendition_status, rendition_storage_path, duration_seconds)
values ('e7400000-0000-4000-8000-000000000001', 'e7300000-0000-4000-8000-000000000001',
        'showcase/e7200000-0000-4000-8000-000000000001/clip.mp4', 'video', 0, 'ready',
        'showcase/e7200000-0000-4000-8000-000000000001/clip.feed.mp4', 37.97),
       ('e7400000-0000-4000-8000-000000000002', 'e7300000-0000-4000-8000-000000000002',
        'showcase/e7200000-0000-4000-8000-000000000002/clip.mp4', 'video', 0, 'ready',
        'showcase/e7200000-0000-4000-8000-000000000001/foreign.feed.mp4', 37.97);
insert into storage.objects (bucket_id, name, metadata)
select 'showcase_media', rendition_storage_path, '{"size":2564475}'::jsonb
from public.post_media where post_id::text like 'e7300000-%';

create temporary table claimed as select * from public.claim_post_media_teaser_repair('worker-showcase');
select is((select count(*) from claimed), 1::bigint, 'admits a rendition filed under the linked generation''s showcase prefix');
select is((select id::text from claimed), 'e7400000-0000-4000-8000-000000000001', 'the owning-generation check is applied, not merely a showcase/ prefix');
select is((select generation_id::text from claimed), 'e7200000-0000-4000-8000-000000000001', 'the claim carries the generation id so the worker can repeat the ownership check');
select is((select count(*) from public.claim_post_media_teaser_repair('worker-two')), 0::bigint, 'a showcase rendition owned by another generation is never admitted');
select * from finish();
rollback;

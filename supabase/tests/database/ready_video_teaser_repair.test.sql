begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('e6100000-0000-4000-8000-000000000001', 'teaser@example.invalid', 'authenticated', 'authenticated', '{}', '{}');
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, showcase_asset_path)
select ('e6300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'e6100000-0000-4000-8000-000000000001'::uuid, 'private', 'video', 'manual', 'media', 'fixture.mp4' from generate_series(1,8) n;
insert into public.post_media (id, post_id, storage_path, media_kind, sort_order,
  rendition_status, rendition_storage_path, duration_seconds, teaser_storage_path, teaser_generated_at)
select ('e6400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
 ('e6300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'original-' || n || '.mp4', 'video', 0,
 case when n = 5 then 'failed' else 'ready' end,
 case when n = 6 then 'posts/another-post/feed.mp4'
 else 'posts/e6300000-0000-4000-8000-' || lpad(n::text, 12, '0') || '/' || n || '.feed.mp4' end,
 case when n = 2 then 30 else 37.97 end,
 case when n = 3 then 'existing-teaser.mp4' else null end,
 case when n = 3 then now() else null end
from generate_series(1,8) n;
insert into storage.objects (bucket_id, name, metadata)
select 'showcase_media', rendition_storage_path,
 case when storage_path = 'original-4.mp4' then '{"size":33554433}'::jsonb
 when storage_path = 'original-7.mp4' then '{"size":"bad"}'::jsonb else '{"size":2564475}'::jsonb end
from public.post_media where post_id::text like 'e6300000-%' and storage_path <> 'original-8.mp4';

create temporary table claimed as select * from public.claim_post_media_teaser_repair('worker-a');
select is((select count(*) from claimed), 1::bigint, 'admits only a long ready video with a bounded stored rendition');
select is((select id::text from claimed), 'e6400000-0000-4000-8000-000000000001', 'excludes short, existing, oversized, failed, foreign, malformed and absent sources');
select is((select source_bytes from claimed), 2564475::bigint, 'admission uses stored object bytes');
select is((select rendition_status from public.post_media where post_id = 'e6300000-0000-4000-8000-000000000001'), 'ready', 'full playback stays ready');
select is((select teaser_attempt_count from public.post_media where id = (select id from claimed)), 1, 'claim consumes attempt before encoding so crashes are bounded');
select is((select count(*) from public.claim_post_media_teaser_repair('worker-b')), 0::bigint, 'active lease excludes another worker');
update public.post_media set teaser_locked_at = now() - interval '6 minutes' where id = (select id from claimed);
select is((select count(*) from public.claim_post_media_teaser_repair('worker-b')), 1::bigint, 'expired lease can recover');
update public.post_media set teaser_locked_at = now() - interval '6 minutes' where id = (select id from claimed);
select is((select count(*) from public.claim_post_media_teaser_repair('worker-c')), 1::bigint, 'last bounded attempt is available');
update public.post_media set teaser_locked_at = now() - interval '6 minutes' where id = (select id from claimed);
select is((select count(*) from public.claim_post_media_teaser_repair('worker-d')), 0::bigint, 'three crashed attempts exhaust admission');
select ok(not has_function_privilege('authenticated', 'public.claim_post_media_teaser_repair(text,bigint)', 'EXECUTE'), 'authenticated cannot claim');
select ok(not has_function_privilege('anon', 'public.claim_post_media_teaser_repair(text,bigint)', 'EXECUTE'), 'anonymous cannot claim');
select ok(has_function_privilege('service_role', 'public.claim_post_media_teaser_repair(text,bigint)', 'EXECUTE'), 'service worker can claim');
select * from finish();
rollback;

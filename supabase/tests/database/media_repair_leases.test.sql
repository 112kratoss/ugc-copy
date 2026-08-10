-- Media preview/rendition workers must atomically own large downloads and
-- ffmpeg work. A second invocation cannot select a live lease.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'e9100000-0000-4000-8000-000000000001'::uuid,
  'media-lease@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
);
insert into public.generations (
  id, user_id, prediction_id, model, status, category, prompt, output_url,
  preview_status, preview_attempt_count, completed_at
)
values (
  'e9200000-0000-4000-8000-000000000001'::uuid,
  'e9100000-0000-4000-8000-000000000001'::uuid,
  'media-lease-task', 'fixture-model', 'succeeded', 'image', 'fixture',
  'generated_images/e9100000/fixture.png', 'pending', 0, now()
);
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, showcase_asset_path
)
values (
  'e9300000-0000-4000-8000-000000000001'::uuid,
  'e9100000-0000-4000-8000-000000000001'::uuid,
  'private', 'video', 'manual', 'media', 'e9100000/fixture.mp4'
);
insert into public.post_media (
  id, post_id, storage_path, media_kind, content_type, sort_order,
  preview_status, preview_attempt_count, rendition_status, rendition_attempt_count
)
values (
  'e9400000-0000-4000-8000-000000000001'::uuid,
  'e9300000-0000-4000-8000-000000000001'::uuid,
  'e9100000/fixture.mp4', 'video', 'video/mp4', 0,
  'pending', 0, 'pending', 0
);

select is(
  (select count(*) from public.claim_generation_preview_repairs(1, 'preview-a', 300, 3)),
  1::bigint, 'one worker claims generation preview work'
);
select is(
  (select preview_status || ':' || preview_locked_by from public.generations
   where id = 'e9200000-0000-4000-8000-000000000001'::uuid),
  'processing:preview-a', 'generation preview claim records ownership'
);
select is(
  (select count(*) from public.claim_generation_preview_repairs(1, 'preview-b', 300, 3)),
  0::bigint, 'a live generation preview lease cannot be claimed twice'
);

select is(
  (select count(*) from public.claim_post_media_preview_repairs(1, 'post-preview-a', 300, 3)),
  1::bigint, 'one worker claims post preview work'
);
select is(
  (select preview_status || ':' || preview_locked_by from public.post_media
   where id = 'e9400000-0000-4000-8000-000000000001'::uuid),
  'processing:post-preview-a', 'post preview claim records ownership'
);
select is(
  (select count(*) from public.claim_post_media_preview_repairs(1, 'post-preview-b', 300, 3)),
  0::bigint, 'a live post preview lease cannot be claimed twice'
);

select is(
  (select count(*) from public.claim_media_rendition_repairs(1, 268435456, 'rendition-a', 300, 3)),
  1::bigint, 'one worker claims rendition work with byte admission'
);
select is(
  (select rendition_status || ':' || rendition_locked_by from public.post_media
   where id = 'e9400000-0000-4000-8000-000000000001'::uuid),
  'processing:rendition-a', 'rendition claim records ownership'
);
select is(
  (select count(*) from public.claim_media_rendition_repairs(1, 268435456, 'rendition-b', 300, 3)),
  0::bigint, 'a live rendition lease cannot launch a second ffmpeg process'
);

update public.post_media
set rendition_locked_at = now() - interval '10 minutes'
where id = 'e9400000-0000-4000-8000-000000000001'::uuid;
select is(
  (select count(*) from public.claim_media_rendition_repairs(1, 268435456, 'rendition-b', 300, 3)),
  1::bigint, 'a crashed rendition lease is reclaimable after TTL'
);
select is(
  (select rendition_locked_by from public.post_media
   where id = 'e9400000-0000-4000-8000-000000000001'::uuid),
  'rendition-b', 'the reclaim transfers ownership explicitly'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_media_rendition_repairs(integer,bigint,text,integer,integer)',
    'EXECUTE'
  ),
  'clients cannot claim internal media work'
);

select * from finish();
rollback;

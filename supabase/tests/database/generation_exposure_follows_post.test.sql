-- posts_sync_generation_exposure: a generation's exposure follows its post in
-- the post write's own transaction, whoever the writer is, and a public copy
-- the post stops needing is queued for revocation.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  'e1000000-0000-4000-8000-00000000e001'::uuid, 'exposure-owner@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
);

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
)
values
  (
    'e2000000-0000-4000-8000-00000000e001'::uuid, 'e1000000-0000-4000-8000-00000000e001'::uuid,
    'exposure-sync-1', 'succeeded', 1, 'image', 'test',
    'generated_images/e1000000-0000-4000-8000-00000000e001/one.jpg', true,
    'showcase/e2000000-0000-4000-8000-00000000e001/one.abc123.jpg'
  ),
  (
    'e2000000-0000-4000-8000-00000000e002'::uuid, 'e1000000-0000-4000-8000-00000000e001'::uuid,
    'exposure-sync-2', 'succeeded', 1, 'image', 'test',
    'generated_images/e1000000-0000-4000-8000-00000000e001/two.jpg', true,
    'showcase/e2000000-0000-4000-8000-00000000e002/two.abc123.jpg'
  );

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url
)
values
  (
    'e3000000-0000-4000-8000-00000000e001'::uuid, 'e1000000-0000-4000-8000-00000000e001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Exposure one',
    'e2000000-0000-4000-8000-00000000e001'::uuid,
    'showcase/e2000000-0000-4000-8000-00000000e001/one.abc123.jpg',
    'generated_images/e1000000-0000-4000-8000-00000000e001/one.jpg'
  ),
  (
    'e3000000-0000-4000-8000-00000000e002'::uuid, 'e1000000-0000-4000-8000-00000000e001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'Exposure two',
    'e2000000-0000-4000-8000-00000000e002'::uuid,
    'showcase/e2000000-0000-4000-8000-00000000e002/two.abc123.jpg',
    'generated_images/e1000000-0000-4000-8000-00000000e001/two.jpg'
  );

-- 1. Made private through the update RPC, the way post-update-service does it.
select public.update_post_with_resource_bundle(
  'e3000000-0000-4000-8000-00000000e001'::uuid,
  'e1000000-0000-4000-8000-00000000e001'::uuid,
  '{"visibility": "private", "showcase_asset_path": null}'::jsonb
);

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'a post made private takes its generation off show in the same transaction'
);
select is(
  (select showcase_asset_path from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  null,
  'and drops the generation''s public derivative with it'
);
select is(
  (
    select reason from public.showcase_media_revocations
    where generation_id = 'e2000000-0000-4000-8000-00000000e001'::uuid
      and showcase_asset_path = 'showcase/e2000000-0000-4000-8000-00000000e001/one.abc123.jpg'
  ),
  'post_unexposed',
  'the public copy the post dropped is queued for revocation'
);
select is(
  (select count(*) from public.showcase_media_revocations where generation_id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  1::bigint,
  'the post''s and the generation''s identical path is queued once'
);

-- 2. Public again, with a fresh derivative.
select public.update_post_with_resource_bundle(
  'e3000000-0000-4000-8000-00000000e001'::uuid,
  'e1000000-0000-4000-8000-00000000e001'::uuid,
  '{"visibility": "public", "showcase_asset_path": "showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg"}'::jsonb
);

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  true,
  'a post made public puts its generation back on show'
);
select is(
  (select showcase_asset_path from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  'showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg',
  'serving the post''s new derivative'
);

-- 3. Unlisted is exposed but not public.
select public.update_post_with_resource_bundle(
  'e3000000-0000-4000-8000-00000000e001'::uuid,
  'e1000000-0000-4000-8000-00000000e001'::uuid,
  '{"visibility": "unlisted"}'::jsonb
);

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'an unlisted post''s generation is not public'
);
select is(
  (select showcase_asset_path from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  'showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg',
  'but still serves its derivative'
);

select public.update_post_with_resource_bundle(
  'e3000000-0000-4000-8000-00000000e001'::uuid,
  'e1000000-0000-4000-8000-00000000e001'::uuid,
  '{"visibility": "public"}'::jsonb
);

-- 4. Archive and restore write only the post, as the lifecycle service does.
update public.posts
set archived_at = now(), archived_by_user_id = 'e1000000-0000-4000-8000-00000000e001'::uuid
where id = 'e3000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'archiving a post takes its generation off show'
);
select is(
  (select showcase_asset_path from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  null,
  'and forgets the generation''s derivative'
);
select is(
  (select showcase_asset_path from public.posts where id = 'e3000000-0000-4000-8000-00000000e001'::uuid),
  'showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg',
  'while the post keeps the path restore needs'
);
select is(
  (
    select count(*) from public.showcase_media_revocations
    where showcase_asset_path = 'showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg'
  ),
  0::bigint,
  'an archived post''s copy is not queued for revocation'
);

update public.posts
set archived_at = null, archived_by_user_id = null
where id = 'e3000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  true,
  'restoring a public post puts its generation back on show'
);
select is(
  (select showcase_asset_path from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  'showcase/e2000000-0000-4000-8000-00000000e001/one.def456.jpg',
  'from the path the post kept'
);

-- 5. Moderation.
update public.posts set review_status = 'hidden' where id = 'e3000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'hidden content is never public'
);
select lives_ok(
  $$select public.update_post_with_resource_bundle(
    'e3000000-0000-4000-8000-00000000e001'::uuid,
    'e1000000-0000-4000-8000-00000000e001'::uuid,
    '{"visibility": "public"}'::jsonb
  )$$,
  'restating public on hidden content does not trip the republish guard'
);
select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'and leaves the generation off show'
);

update public.posts set review_status = 'visible' where id = 'e3000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  true,
  'content shown again by moderation is public again'
);

-- 6. An operator removal owns the generation while it stands.
update public.generations
set moderation_removed_at = now(), is_public = false
where id = 'e2000000-0000-4000-8000-00000000e001'::uuid;

update public.posts set visibility = 'public' where id = 'e3000000-0000-4000-8000-00000000e001'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e001'::uuid),
  false,
  'a post write never re-publishes an operator-removed generation'
);

-- 7. A direct delete.
delete from public.posts where id = 'e3000000-0000-4000-8000-00000000e002'::uuid;

select is(
  (select is_public from public.generations where id = 'e2000000-0000-4000-8000-00000000e002'::uuid),
  false,
  'deleting a post takes its generation off show'
);
select is(
  (select reason from public.showcase_media_revocations where generation_id = 'e2000000-0000-4000-8000-00000000e002'::uuid),
  'post_deleted',
  'and queues the public copy it left behind'
);

-- 8. The queue itself.
select ok(
  not has_table_privilege('authenticated', 'public.showcase_media_revocations', 'SELECT')
  and not has_table_privilege('anon', 'public.showcase_media_revocations', 'SELECT')
  and not has_table_privilege('service_role', 'public.showcase_media_revocations', 'INSERT')
  and has_table_privilege('service_role', 'public.showcase_media_revocations', 'DELETE'),
  'the revocation queue is service-role only, and only the trigger adds to it'
);

select finish();

rollback;

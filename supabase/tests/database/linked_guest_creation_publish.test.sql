-- A creation made as a guest, published by the account the guest registered
-- as (20261015054611_merge_carries_guest_feed_preferences.sql, finding 02-4 of
-- the 2026-10-15 auth and pricing comparison).
--
-- The creation keeps the guest's id after the merge. The publish RPC accepts
-- it for the linked account and writes the post as that account; an account
-- the guest is not linked to is still refused. The post's archive, restore,
-- unpublish, delete and unlink move the creation's exposure as they do for an
-- account's own creation, and a post whose owner is not linked to the guest
-- moves nothing.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

-- ─── Surface ─────────────────────────────────────────────────────────────────

select ok(
  has_function_privilege('service_role',
    'public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean)', 'EXECUTE'),
  'the publish RPC stays callable by the service role only'
);
select ok(
  (select procedures.prosecdef and procedures.proconfig @> array['search_path=public']
   from pg_catalog.pg_proc as procedures
   where procedures.oid =
     'public.publish_generation_post_with_resource_bundle(uuid, uuid, jsonb, jsonb, jsonb, boolean)'::regprocedure),
  'the publish RPC still runs as its owner with its search path'
);
select ok(
  (select procedures.prosecdef
     and procedures.proconfig @> array['search_path=""']
     and not has_function_privilege('service_role', procedures.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
   from pg_catalog.pg_proc as procedures
   where procedures.oid = 'public.sync_generation_exposure_with_post()'::regprocedure),
  'the exposure trigger function keeps its trusted owner and no caller grants'
);
select ok(
  exists(
    select 1 from pg_catalog.pg_trigger as triggers
    where triggers.tgrelid = 'public.posts'::regclass
      and triggers.tgname = 'posts_sync_generation_exposure'
      and triggers.tgfoid = 'public.sync_generation_exposure_with_post()'::regprocedure
  ),
  'posts still run the exposure trigger'
);

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- G (…01) is a guest that made four creations (G1-G4) and then registered as
-- T (…02). U (…03) is an account G is not linked to.

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at
) values
  ('c6a00000-0000-4000-8000-000000000001', null,
   'authenticated', 'authenticated', true, '{}', '{}', now()),
  ('c6a00000-0000-4000-8000-000000000002', 'linked-publish-owner@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('c6a00000-0000-4000-8000-000000000003', 'linked-publish-stranger@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now());

-- G4 is already on show, as if published; it is the stranger's target below.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
) values
  ('c6b00000-0000-4000-8000-000000000001', 'c6a00000-0000-4000-8000-000000000001',
   'linked-publish-1', 'succeeded', 1, 'image', 'test',
   'generated_images/c6a00000-0000-4000-8000-000000000001/one.jpg', false, null),
  ('c6b00000-0000-4000-8000-000000000002', 'c6a00000-0000-4000-8000-000000000001',
   'linked-publish-2', 'succeeded', 1, 'image', 'test',
   'generated_images/c6a00000-0000-4000-8000-000000000001/two.jpg', false, null),
  ('c6b00000-0000-4000-8000-000000000003', 'c6a00000-0000-4000-8000-000000000001',
   'linked-publish-3', 'succeeded', 1, 'image', 'test',
   'generated_images/c6a00000-0000-4000-8000-000000000001/three.jpg', false, null),
  ('c6b00000-0000-4000-8000-000000000004', 'c6a00000-0000-4000-8000-000000000001',
   'linked-publish-4', 'succeeded', 1, 'image', 'test',
   'generated_images/c6a00000-0000-4000-8000-000000000001/four.jpg', true,
   'showcase/c6b00000-0000-4000-8000-000000000004/four.abc123.jpg');

select is(
  public.merge_guest_account(
    'c6a00000-0000-4000-8000-000000000001',
    'c6a00000-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'merged',
  'the guest registers and is linked to its account'
);

-- The RPC's arguments as showcase-publish-service.ts builds them: the owner and
-- the post's user_id are the caller.
create temporary table linked_publish (
  generation_id uuid, post_id uuid, visibility text, bundle_id uuid, bundle_status text
);

create function pg_temp.publish_as(p_owner uuid, p_generation uuid, p_path text)
returns uuid
language sql
as $$
  select result.post_id
  from public.publish_generation_post_with_resource_bundle(
    p_generation,
    p_owner,
    jsonb_build_object('is_public', true, 'showcase_asset_path', p_path, 'title', 'Made as a guest'),
    jsonb_build_object(
      'is_nsfw', false,
      'user_id', p_owner,
      'visibility', 'public',
      'category', 'image',
      'title', 'Made as a guest',
      'post_format', 'media',
      'source_kind', 'magicbooklet',
      'generation_id', p_generation,
      'showcase_asset_path', p_path,
      'output_url', (select output_url from public.generations where id = p_generation)
    ),
    null,
    false
  ) as result;
$$;

-- ─── The account publishes what its guest made ───────────────────────────────

select lives_ok(
  $$ insert into linked_publish (generation_id, post_id)
     select 'c6b00000-0000-4000-8000-000000000001'::uuid,
       pg_temp.publish_as(
         'c6a00000-0000-4000-8000-000000000002',
         'c6b00000-0000-4000-8000-000000000001',
         'showcase/c6b00000-0000-4000-8000-000000000001/one.abc123.jpg') $$,
  'a registered account publishes a creation its linked guest made'
);
select is(
  (select posts.user_id from public.posts
   join linked_publish on linked_publish.post_id = posts.id
   where linked_publish.generation_id = 'c6b00000-0000-4000-8000-000000000001'),
  'c6a00000-0000-4000-8000-000000000002'::uuid,
  'the post carries the account''s id'
);
select is(
  (select generation_id from public.posts
   where user_id = 'c6a00000-0000-4000-8000-000000000002'
     and generation_id = 'c6b00000-0000-4000-8000-000000000001'),
  'c6b00000-0000-4000-8000-000000000001'::uuid,
  'and points at the guest-made creation'
);
select is(
  (select user_id from public.generations where id = 'c6b00000-0000-4000-8000-000000000001'),
  'c6a00000-0000-4000-8000-000000000001'::uuid,
  'the creation keeps the guest''s id, as every linked row does'
);
select is(
  (select is_public::text || ' ' || showcase_asset_path from public.generations
   where id = 'c6b00000-0000-4000-8000-000000000001'),
  'true showcase/c6b00000-0000-4000-8000-000000000001/one.abc123.jpg',
  'the creation is on show with the post''s derivative'
);

select throws_ok(
  $$ select pg_temp.publish_as(
       'c6a00000-0000-4000-8000-000000000003',
       'c6b00000-0000-4000-8000-000000000002',
       'showcase/c6b00000-0000-4000-8000-000000000002/two.abc123.jpg') $$,
  'P0001',
  'Generation not found or not owned by user',
  'an account the guest is not linked to is still refused'
);
select is(
  (select count(*) from public.posts where generation_id = 'c6b00000-0000-4000-8000-000000000002'),
  0::bigint,
  'and nothing is written for it'
);

-- ─── The creation's exposure follows the account's post ──────────────────────

-- Archive and restore write only the post, as the lifecycle service does.
update public.posts
set archived_at = now(), archived_by_user_id = 'c6a00000-0000-4000-8000-000000000002'
where generation_id = 'c6b00000-0000-4000-8000-000000000001';

select is(
  (select is_public from public.generations where id = 'c6b00000-0000-4000-8000-000000000001'),
  false,
  'archiving the post takes the guest-made creation off show'
);
select is(
  (select showcase_asset_path from public.generations where id = 'c6b00000-0000-4000-8000-000000000001'),
  null,
  'and forgets its derivative'
);

update public.posts
set archived_at = null, archived_by_user_id = null
where generation_id = 'c6b00000-0000-4000-8000-000000000001';

select is(
  (select is_public::text || ' ' || showcase_asset_path from public.generations
   where id = 'c6b00000-0000-4000-8000-000000000001'),
  'true showcase/c6b00000-0000-4000-8000-000000000001/one.abc123.jpg',
  'restoring the post puts it back on show from the path the post kept'
);

-- Made private through the update RPC, as post-update-service does it.
select lives_ok(
  $$ select public.update_post_with_resource_bundle(
       (select id from public.posts where generation_id = 'c6b00000-0000-4000-8000-000000000001'),
       'c6a00000-0000-4000-8000-000000000002',
       '{"visibility": "private", "showcase_asset_path": null}'::jsonb
     ) $$,
  'the account makes the post private'
);
select is(
  (select is_public from public.generations where id = 'c6b00000-0000-4000-8000-000000000001'),
  false,
  'which takes the guest-made creation off show'
);
select is(
  (select reason from public.showcase_media_revocations
   where generation_id = 'c6b00000-0000-4000-8000-000000000001'
     and showcase_asset_path = 'showcase/c6b00000-0000-4000-8000-000000000001/one.abc123.jpg'),
  'post_unexposed',
  'and queues the public copy the post dropped'
);

-- A direct delete.
select lives_ok(
  $$ insert into linked_publish (generation_id, post_id)
     select 'c6b00000-0000-4000-8000-000000000002'::uuid,
       pg_temp.publish_as(
         'c6a00000-0000-4000-8000-000000000002',
         'c6b00000-0000-4000-8000-000000000002',
         'showcase/c6b00000-0000-4000-8000-000000000002/two.abc123.jpg') $$,
  'the account publishes a second guest-made creation'
);

delete from public.posts where generation_id = 'c6b00000-0000-4000-8000-000000000002';

select is(
  (select is_public::text || ' ' || coalesce(showcase_asset_path, 'no path') from public.generations
   where id = 'c6b00000-0000-4000-8000-000000000002'),
  'false no path',
  'deleting the post takes that creation off show'
);
select is(
  (select reason from public.showcase_media_revocations
   where generation_id = 'c6b00000-0000-4000-8000-000000000002'),
  'post_deleted',
  'and queues the public copy it left behind'
);

-- A post that stops pointing at the creation.
select lives_ok(
  $$ insert into linked_publish (generation_id, post_id)
     select 'c6b00000-0000-4000-8000-000000000003'::uuid,
       pg_temp.publish_as(
         'c6a00000-0000-4000-8000-000000000002',
         'c6b00000-0000-4000-8000-000000000003',
         'showcase/c6b00000-0000-4000-8000-000000000003/three.abc123.jpg') $$,
  'the account publishes a third guest-made creation'
);

update public.posts
set generation_id = null
where id = (select post_id from linked_publish
            where generation_id = 'c6b00000-0000-4000-8000-000000000003');

select is(
  (select is_public::text || ' ' || coalesce(showcase_asset_path, 'no path') from public.generations
   where id = 'c6b00000-0000-4000-8000-000000000003'),
  'false no path',
  'a post that stops linking to a guest-made creation takes it off show'
);

-- ─── Accounts that are not linked ────────────────────────────────────────────
-- A post the stranger owns that names the guest's creation (a historical direct
-- write could) never moves that creation's exposure.

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  generation_id, showcase_asset_path, output_url
) values (
  'c6c00000-0000-4000-8000-000000000004', 'c6a00000-0000-4000-8000-000000000003',
  'private', 'image', 'magicbooklet', 'media', 'Not the stranger''s',
  'c6b00000-0000-4000-8000-000000000004', null,
  'generated_images/c6a00000-0000-4000-8000-000000000001/four.jpg'
);

select is(
  (select is_public::text || ' ' || showcase_asset_path from public.generations
   where id = 'c6b00000-0000-4000-8000-000000000004'),
  'true showcase/c6b00000-0000-4000-8000-000000000004/four.abc123.jpg',
  'a private post by an account the guest is not linked to leaves the creation as it was'
);

delete from public.posts where id = 'c6c00000-0000-4000-8000-000000000004';

select is(
  (select is_public from public.generations where id = 'c6b00000-0000-4000-8000-000000000004'),
  true,
  'and so does deleting that post'
);
select is(
  (select count(*) from public.showcase_media_revocations
   where generation_id = 'c6b00000-0000-4000-8000-000000000004'),
  0::bigint,
  'with nothing queued against the creation'
);

select * from finish();
rollback;

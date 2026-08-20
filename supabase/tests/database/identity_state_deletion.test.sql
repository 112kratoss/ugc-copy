begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

insert into auth.users (
  id,
  email,
  aud,
  role,
  is_anonymous,
  raw_app_meta_data,
  raw_user_meta_data
) values
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'identity-target@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb),
  ('b1000000-0000-4000-8000-000000000002'::uuid, null,
   'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb),
  ('c1000000-0000-4000-8000-000000000003'::uuid, 'identity-active@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb),
  ('d1000000-0000-4000-8000-000000000004'::uuid, null,
   'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb);

insert into storage.objects (id, bucket_id, name, metadata, created_at)
values (
  gen_random_uuid(),
  'generated_images',
  'b1000000-0000-4000-8000-000000000002/identity-state.png',
  '{"size": 64, "mimetype": "image/png"}'::jsonb,
  timezone('utc'::text, now())
);

-- Historical direct post writes did not bind generation_id to the post owner.
-- A poisoned owned post must never authorize deletion of another creator's
-- global showcase namespace.
insert into public.generations (
  id, user_id, model, status, is_public, showcase_asset_path
) values
  (
    'e1000000-0000-4000-8000-000000000005'::uuid,
    'c1000000-0000-4000-8000-000000000003'::uuid,
    'identity-fixture', 'succeeded', true,
    'showcase/e1000000-0000-4000-8000-000000000005/victim.webp'
  ),
  (
    'e2000000-0000-4000-8000-000000000006'::uuid,
    'a1000000-0000-4000-8000-000000000001'::uuid,
    'identity-fixture', 'succeeded', false,
    ' showcase/e2000000-0000-4000-8000-000000000006/noncanonical.webp'
  );

insert into public.posts (
  id, user_id, visibility, category, source_kind, generation_id,
  showcase_asset_path
) values (
  'f1000000-0000-4000-8000-000000000007'::uuid,
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'private', 'image', 'external',
  'e1000000-0000-4000-8000-000000000005'::uuid,
  'showcase/e1000000-0000-4000-8000-000000000005/victim.webp'
);

update public.profiles
set merged_into_user_id = 'a1000000-0000-4000-8000-000000000001'::uuid,
    merged_at = timezone('utc'::text, now())
where id = 'b1000000-0000-4000-8000-000000000002'::uuid;

select is(
  (select identity_state from public.profiles
   where id = 'b1000000-0000-4000-8000-000000000002'::uuid),
  'merged',
  'linking a guest atomically moves its durable identity state to merged'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  public.current_identity_state(),
  'merged',
  'the current-subject state RPC reports a spent guest session'
);
select is(
  public.current_identity_is_active(),
  false,
  'a merged identity fails the shared active-state predicate'
);
select is(
  (select count(*) from public.profiles
   where id = 'b1000000-0000-4000-8000-000000000002'::uuid),
  0::bigint,
  'restrictive RLS blocks a stale merged token from direct Data API reads'
);
select is(
  (select count(*) from storage.objects
   where name = 'b1000000-0000-4000-8000-000000000002/identity-state.png'),
  0::bigint,
  'restrictive Storage RLS blocks a stale merged token from its former owner prefix'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select is(
  public.current_identity_is_active(),
  true,
  'an ordinary active identity remains admitted'
);
reset role;

select throws_ok(
  $$ update public.profiles
     set merged_at = timezone('utc'::text, now())
     where id = 'd1000000-0000-4000-8000-000000000004'::uuid $$,
  '23514',
  null,
  'a surviving merge marker can never coexist with a reactivated identity'
);

update public.profiles
set identity_state = 'deleting',
    merged_at = timezone('utc'::text, now())
where id = 'd1000000-0000-4000-8000-000000000004'::uuid;

select is(
  (select identity_state from public.profiles
   where id = 'd1000000-0000-4000-8000-000000000004'::uuid),
  'deleting',
  'an orphaned historical merged guest is fail-closed as deleting'
);

create temporary table orphan_deletion_preparation as
select public.prepare_account_deletion(
  'd1000000-0000-4000-8000-000000000004'::uuid
) as payload;

select is(
  (select payload->>'status' from orphan_deletion_preparation),
  'prepared',
  'an orphaned historical merged guest gets a durable deletion job'
);
select is(
  (
    select jsonb_array_length(payload->'storage_manifest'->'owner_user_ids')
    from orphan_deletion_preparation
  ),
  1,
  'the orphan cleanup manifest retains its independent Auth and storage owner ID'
);

create temporary table deletion_preparation as
select public.prepare_account_deletion(
  'a1000000-0000-4000-8000-000000000001'::uuid
) as payload;

select is(
  (select payload->>'status' from deletion_preparation),
  'prepared',
  'linked account deletion is durably prepared'
);
select is(
  (
    select jsonb_array_length(payload->'storage_manifest'->'owner_user_ids')
    from deletion_preparation
  ),
  2,
  'the deletion manifest snapshots the target and linked guest IDs'
);
select is(
  (
    select count(*)
    from deletion_preparation,
      jsonb_array_elements_text(
        payload->'storage_manifest'->'showcase_media_paths'
      ) as manifest_path(path)
    where manifest_path.path =
      'showcase/e1000000-0000-4000-8000-000000000005/victim.webp'
  ),
  0::bigint,
  'an owned post cannot authorize a foreign generation showcase namespace'
);
select is(
  (
    select count(*)
    from deletion_preparation,
      jsonb_array_elements_text(
        payload->'storage_manifest'->'showcase_media_paths'
      ) as manifest_path(path)
    where manifest_path.path =
      ' showcase/e2000000-0000-4000-8000-000000000006/noncanonical.webp'
  ),
  1::bigint,
  'the manifest preserves non-canonical bytes so application parsing fails closed'
);
select is(
  (select identity_state from public.profiles
   where id = 'a1000000-0000-4000-8000-000000000001'::uuid),
  'deleting',
  'preparation marks the target deleting atomically'
);
select is(
  (select identity_state from public.profiles
   where id = 'b1000000-0000-4000-8000-000000000002'::uuid),
  'deleting',
  'preparation marks every linked guest deleting atomically'
);

select lives_ok(
  $$ delete from auth.users
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  'the additive release remains compatible with the previously deployed target-first worker'
);
select is(
  (
    select identity_state || ':' || coalesce(merged_into_user_id::text, 'detached')
    from public.profiles
    where id = 'b1000000-0000-4000-8000-000000000002'::uuid
  ),
  'deleting:detached',
  'target-first SET NULL leaves the spent guest fail-closed rather than active'
);
select is(
  (
    select storage_manifest->'owner_user_ids'->>0
    from public.account_deletion_jobs
    where user_id = 'b1000000-0000-4000-8000-000000000002'::uuid
  ),
  'b1000000-0000-4000-8000-000000000002',
  'target-first compatibility atomically enqueues an independent durable guest cleanup'
);
select lives_ok(
  $$ delete from auth.users
     where id = 'b1000000-0000-4000-8000-000000000002'::uuid $$,
  'guest-first Auth deletion succeeds'
);
select lives_ok(
  $$ delete from auth.users
     where id = 'a1000000-0000-4000-8000-000000000001'::uuid $$,
  'a target deletion retry remains idempotent after every linked guest is gone'
);

select is(
  (
    with authenticated_tables as (
      select distinct relation.oid
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(relation.relacl) as acl
      join pg_roles as grantee on grantee.oid = acl.grantee
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and grantee.rolname = 'authenticated'
        and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      union
      select distinct relation.oid
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_attribute as attribute on attribute.attrelid = relation.oid
      cross join lateral aclexplode(attribute.attacl) as acl
      join pg_roles as grantee on grantee.oid = acl.grantee
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and attribute.attnum > 0
        and not attribute.attisdropped
        and grantee.rolname = 'authenticated'
        and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    )
    select count(*)
    from authenticated_tables as granted
    where not exists (
      select 1
      from pg_policy as policy
      where policy.polrelid = granted.oid
        and policy.polname = 'authenticated_identity_active'
        and not policy.polpermissive
        and (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
    )
  ),
  0::bigint,
  'every explicit authenticated Data API table grant has restrictive identity-state RLS'
);

select is(
  (
    with authenticated_tables as (
      select distinct relation.oid, relation.relname::text as relname
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(relation.relacl) as acl
      join pg_roles as grantee on grantee.oid = acl.grantee
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and grantee.rolname = 'authenticated'
        and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      union
      select distinct relation.oid, relation.relname::text as relname
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      join pg_attribute as attribute on attribute.attrelid = relation.oid
      cross join lateral aclexplode(attribute.attacl) as acl
      join pg_roles as grantee on grantee.oid = acl.grantee
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and attribute.attnum > 0
        and not attribute.attisdropped
        and grantee.rolname = 'authenticated'
        and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    )
    select coalesce(array_agg(granted.relname order by granted.relname), array[]::text[])
    from authenticated_tables as granted
    where not exists (
      select 1
      from pg_policy as policy
      where policy.polrelid = granted.oid
        and policy.polpermissive
        and (
          0 = any(policy.polroles)
          or (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
        )
    )
  ),
  array[]::text[],
  'every authenticated Data API grant has an authenticated permissive policy'
);

select ok(
  exists (
    select 1
    from pg_policy as policy
    where policy.polrelid = 'storage.objects'::regclass
      and policy.polname = 'authenticated_identity_active'
      and not policy.polpermissive
      and (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
  ),
  'storage objects have the restrictive authenticated identity-state policy'
);

select ok(
  exists (
    select 1
    from pg_policy as policy
    where policy.polrelid = 'storage.buckets'::regclass
      and policy.polname = 'authenticated_identity_active'
      and not policy.polpermissive
      and (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
  ),
  'storage buckets have the restrictive authenticated identity-state policy'
);

select * from finish();
rollback;

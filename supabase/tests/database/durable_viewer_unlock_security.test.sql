-- Service-only escrow data and unlock projections must never be callable or
-- queryable through PostgREST client roles.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

select ok(
  not has_function_privilege(
    'anon',
    'public.list_creator_purchased_revisions_for_retention(uuid)',
    'EXECUTE'
  ),
  'anonymous clients cannot enumerate creator revisions for retention'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_creator_purchased_revisions_for_retention(uuid)',
    'EXECUTE'
  ),
  'authenticated clients cannot enumerate creator revisions for retention'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.get_viewer_post_resource_unlock(uuid, uuid)',
    'EXECUTE'
  ),
  'anonymous clients cannot invoke the buyer-scoped unlock projection'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_viewer_post_resource_unlock(uuid, uuid)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke the buyer-scoped unlock projection directly'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_viewer_post_resource_unlocks(uuid, integer, integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke the unlock-library projection directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.list_creator_purchased_revisions_for_retention(uuid)',
    'EXECUTE'
  ),
  'the service role can enumerate creator revisions for retention'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.get_viewer_post_resource_unlock(uuid, uuid)',
    'EXECUTE'
  ),
  'the service role can invoke the buyer-scoped unlock projection'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "d0000000-0000-4000-8000-000000000001", "role": "authenticated"}',
  true
);

select throws_ok(
  $$select revision_id from public.post_resource_bundle_revision_files$$,
  '42501',
  null,
  'authenticated clients cannot read retained file mappings'
);

select throws_ok(
  $$select revision_id from public.post_resource_bundle_revision_supplements$$,
  '42501',
  null,
  'authenticated clients cannot read revision supplements'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$select revision_id from public.post_resource_bundle_revision_files$$,
  '42501',
  null,
  'anonymous clients cannot read retained file mappings'
);

select throws_ok(
  $$select revision_id from public.post_resource_bundle_revision_supplements$$,
  '42501',
  null,
  'anonymous clients cannot read revision supplements'
);

reset role;

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.post_resource_bundle_revision_files'::regclass
  ) and (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.post_resource_bundle_revision_supplements'::regclass
  ),
  'RLS stays enabled on both escrow tables'
);

select * from finish();
rollback;

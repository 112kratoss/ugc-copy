begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists plpgsql_check with schema extensions;
set local search_path = public, extensions;

select plan(7);

select ok(
  to_regprocedure('public.publish_generation_model_catalog(uuid,text)') is not null,
  'catalog publisher RPC exists'
);

select ok(
  not (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'public.publish_generation_model_catalog(uuid,text)'::regprocedure
  ),
  'catalog publisher remains security invoker'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.publish_generation_model_catalog(uuid,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.publish_generation_model_catalog(uuid,text)',
    'EXECUTE'
  ),
  'catalog publisher remains service-role only'
);

create temporary table catalog_publish_lint_context as
select
  active_release.revision as active_revision,
  public.clone_generation_model_catalog(
    active_release.revision,
    'lint-test-' || txid_current()::text,
    'rollback-only catalog publisher validation',
    'database-test'
  ) as draft_release_id
from public.generation_model_catalog_releases as active_release
where active_release.status = 'active'
order by active_release.schema_version
limit 1;

update public.generation_model_catalog_entries as entry
set provider_model_map = '{}'::jsonb
where (entry.release_id, entry.model_id) = (
  select context.draft_release_id, candidate.model_id
  from catalog_publish_lint_context as context
  join lateral (
    select cloned.model_id
    from public.generation_model_catalog_entries as cloned
    where cloned.release_id = context.draft_release_id
    order by cloned.model_id
    limit 1
  ) as candidate on true
);

select throws_ok(
  format(
    'select public.publish_generation_model_catalog(%L::uuid, %L::text)',
    draft_release_id,
    active_revision
  ),
  'P0001',
  'One or more catalog entries are invalid',
  'publisher rejects an empty provider model map'
)
from catalog_publish_lint_context;

update public.generation_model_catalog_entries
set provider_model_map = jsonb_build_object('default', 'lint-test/provider')
where release_id = (
  select draft_release_id from catalog_publish_lint_context
)
and provider_model_map = '{}'::jsonb;

select is(
  public.publish_generation_model_catalog(draft_release_id, active_revision) ->> 'status',
  'published',
  'publisher accepts non-empty provider model maps'
)
from catalog_publish_lint_context;

select ok(
  not pg_catalog.pg_get_functiondef(
    'public.validate_generation_model_catalog_release(uuid)'::regprocedure
  ) like '%jsonb_object_length(%'
  and pg_catalog.pg_get_functiondef(
    'public.validate_generation_model_catalog_release(uuid)'::regprocedure
  ) like '%provider_model_map = ''{}''::jsonb%',
  'installed catalog validator uses the supported empty-object predicate'
);

select ok(
  not exists (
    select 1
    from extensions.plpgsql_check_function_tb(
      funcoid => 'public.publish_generation_model_catalog(uuid,text)'::regprocedure,
      fatal_errors => true,
      other_warnings => true,
      extra_warnings => true
    )
  ),
  'installed function passes PL/pgSQL lint checks'
);

select * from finish();
rollback;

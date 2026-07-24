begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists plpgsql_check with schema extensions;
set local search_path = public, extensions;

select plan(18);

select has_column(
  'public',
  'generation_model_catalog_entries',
  'adapter_config',
  'catalog entries store private adapter configuration'
);

select ok(
  to_regprocedure('public.stage_generation_model_catalog(jsonb,text)') is not null,
  'atomic catalog stage RPC exists'
);

select ok(
  to_regprocedure('public.validate_generation_model_catalog_release(uuid)') is not null,
  'catalog release validator exists'
);

select ok(
  not (
    select prosecdef
    from pg_catalog.pg_proc
    where oid = 'public.stage_generation_model_catalog(jsonb,text)'::regprocedure
  ),
  'catalog stage RPC remains security invoker'
);

select ok(
  not pg_catalog.has_function_privilege(
    'authenticated',
    'public.stage_generation_model_catalog(jsonb,text)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.stage_generation_model_catalog(jsonb,text)',
    'EXECUTE'
  ),
  'catalog stage RPC remains service-role only'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'generation_model_catalog_one_active_idx'
      and indexdef not like '%schema_version%'
      and indexdef like '%status%'
  ),
  'only one release can be globally active'
);

create temporary table catalog_v2_test_context as
select
  active_release.revision as original_revision,
  'catalog-v2-test-' || txid_current()::text as target_revision,
  jsonb_build_object(
    'schemaVersion', 2,
    'revision', 'catalog-v2-test-' || txid_current()::text,
    'defaults', active_release.defaults,
    'changeNote', 'database test schema v2 release',
    'createdBy', 'database-test',
    'entries', (
      select jsonb_agg(
        jsonb_build_object(
          'modelId', entry.model_id,
          'kind', model.kind,
          'publicDescriptor',
            entry.public_descriptor || jsonb_build_object(
              'schemaVersion', 2,
              'availability', jsonb_build_object(
                'web', entry.web_enabled,
                'mobile', entry.mobile_enabled
              ),
              'inputModes', jsonb_build_array(
                jsonb_build_object(
                  'key', 'default',
                  'label', 'Default',
                  'default', true,
                  'slots', '[]'::jsonb
                )
              ),
              'inputConstraints', '[]'::jsonb
            ),
          'webEnabled', entry.web_enabled,
          'mobileEnabled', entry.mobile_enabled,
          'adapterKey', entry.adapter_key,
          'adapterConfig', entry.adapter_config,
          'providerModelMap', entry.provider_model_map,
          'pricingStrategy', entry.pricing_strategy,
          'pricingConfig', entry.pricing_config,
          'validationStrategy', entry.validation_strategy,
          'validationConfig', entry.validation_config,
          'verificationConfig', entry.verification_config
        )
        order by entry.model_id
      )
      from public.generation_model_catalog_entries as entry
      join public.generation_models as model on model.model_id = entry.model_id
      where entry.release_id = active_release.id
    )
  ) as manifest
from public.generation_model_catalog_releases as active_release
where active_release.status = 'active';

select lives_ok(
  format(
    'select public.stage_generation_model_catalog(%L::jsonb, %L::text)',
    manifest,
    original_revision
  ),
  'a complete schema v2 release stages atomically'
)
from catalog_v2_test_context;

select is(
  (
    select status
    from public.generation_model_catalog_releases
    where revision = context.target_revision
  ),
  'shadow',
  'a staged release is immutable and ready for shadow preview'
)
from catalog_v2_test_context as context;

select ok(
  not exists (
    select 1
    from catalog_v2_test_context as context
    join public.generation_model_catalog_releases as release
      on release.revision = context.target_revision
    join public.generation_model_catalog_entries as entry
      on entry.release_id = release.id
    where entry.public_descriptor ->> 'schemaVersion' <> '2'
      or jsonb_typeof(entry.public_descriptor -> 'inputModes') <> 'array'
      or jsonb_typeof(entry.public_descriptor -> 'inputConstraints') <> 'array'
  ),
  'every staged descriptor has the schema v2 contract'
);

select throws_ok(
  format(
    'select public.stage_generation_model_catalog(%L::jsonb, %L::text)',
    jsonb_set(
      jsonb_set(
        manifest,
        '{revision}',
        to_jsonb('catalog-v2-negative-' || txid_current()::text)
      ),
      '{entries,0,pricingConfig}',
      '{"price": -1}'::jsonb
    ),
    original_revision
  ),
  'P0001',
  'One or more catalog entries are invalid',
  'staging rejects negative pricing'
)
from catalog_v2_test_context;

select throws_ok(
  format(
    'select public.stage_generation_model_catalog(%L::jsonb, %L::text)',
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            manifest,
            '{revision}',
            to_jsonb('catalog-v2-rule-' || txid_current()::text)
          ),
          '{entries,0,validationStrategy}',
          '"descriptor-rules-v1"'::jsonb
        ),
        '{entries,0,validationConfig}',
        '{"rules": [{"type": "max-slot-count", "max": 3}]}'::jsonb
      ),
      '{entries,0,adapterConfig}',
      '{}'::jsonb
    ),
    original_revision
  ),
  'P0001',
  'One or more validation rules are unsupported',
  'staging rejects a malformed allowlisted validation rule'
)
from catalog_v2_test_context;

select throws_ok(
  format(
    'select public.stage_generation_model_catalog(%L::jsonb, %L::text)',
    jsonb_set(
      jsonb_set(
        manifest,
        '{revision}',
        to_jsonb('catalog-v2-default-' || txid_current()::text)
      ),
      '{defaults,web,video}',
      '"missing-video-model"'::jsonb
    ),
    original_revision
  ),
  'P0001',
  'Invalid video default for web',
  'staging rejects an invalid platform default'
)
from catalog_v2_test_context;

select is(
  public.publish_generation_model_catalog(
    release.id,
    context.original_revision
  ) ->> 'status',
  'published',
  'the staged v2 release publishes atomically'
)
from catalog_v2_test_context as context
join public.generation_model_catalog_releases as release
  on release.revision = context.target_revision;

select is(
  (
    select count(*)::integer
    from public.generation_model_catalog_releases
    where status = 'active'
  ),
  1,
  'publishing leaves exactly one active release'
);

select is(
  public.rollback_generation_model_catalog(
    context.original_revision,
    context.target_revision
  ) ->> 'status',
  'rolled_back',
  'the previous release rolls back atomically'
)
from catalog_v2_test_context as context;

select is(
  (
    select revision
    from public.generation_model_catalog_releases
    where status = 'active'
  ),
  original_revision,
  'rollback restores the original active revision'
)
from catalog_v2_test_context;

select ok(
  not exists (
    select 1
    from extensions.plpgsql_check_function_tb(
      funcoid => 'public.stage_generation_model_catalog(jsonb,text)'::regprocedure,
      fatal_errors => true,
      other_warnings => true,
      extra_warnings => true
    )
  ),
  'catalog stage RPC passes PL/pgSQL lint checks'
);

select ok(
  not exists (
    select 1
    from extensions.plpgsql_check_function_tb(
      funcoid => 'public.validate_generation_model_catalog_release(uuid)'::regprocedure,
      fatal_errors => true,
      other_warnings => true,
      extra_warnings => true
    )
  ),
  'catalog release validator passes PL/pgSQL lint checks'
);

select * from finish();
rollback;

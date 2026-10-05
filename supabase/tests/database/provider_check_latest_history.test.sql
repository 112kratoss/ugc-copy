begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

create temporary table audit_provider_context as
select gen_random_uuid() as release_id, gen_random_uuid() as other_release_id,
  array(select model_id from public.generation_models where kind='image' order by model_id limit 2) as models;
insert into public.generation_model_catalog_releases(id,revision,defaults)
select release_id,'audit-latest-'||release_id,'{"web":{},"mobile":{}}'::jsonb from audit_provider_context
union all
select other_release_id,'audit-other-'||other_release_id,'{"web":{},"mobile":{}}'::jsonb from audit_provider_context;
insert into public.generation_model_catalog_entries(release_id,model_id,public_descriptor,adapter_key,provider_model_map,pricing_strategy,pricing_config,validation_strategy)
select releases.id,model,'{}','image-v1','{}','image-v1','{}','image-v1'
from audit_provider_context context
cross join lateral unnest(array[context.release_id,context.other_release_id]) releases(id)
cross join lateral unnest(context.models) models(model);

select is(public.latest_generation_model_provider_checks(null),'[]'::jsonb,'null release has no observations');
select is(public.latest_generation_model_provider_checks(gen_random_uuid()),'[]'::jsonb,'unknown release has no observations');
select is(public.latest_generation_model_provider_checks(release_id),'[]'::jsonb,'models without observations are omitted') from audit_provider_context;

insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at)
select release_id,models[2],'error',7,'2006-01-01' from audit_provider_context;
insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at)
select release_id,models[1],'available',0,'2006-02-01'::timestamptz+n*interval '1 minute'
from audit_provider_context cross join generate_series(1,101) n;
insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at)
select other_release_id,models[2],'available',0,'2006-03-01' from audit_provider_context;

select is(jsonb_array_length(public.latest_generation_model_provider_checks(release_id)),2,'exactly one latest observation per checked model') from audit_provider_context;
select is(public.latest_generation_model_provider_checks(release_id)->1->>'consecutive_discrepancies','7','busy prefix cannot hide sparse-model history') from audit_provider_context;
select is(public.latest_generation_model_provider_checks(release_id)->1->>'status','error','other releases do not override model history') from audit_provider_context;

insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at)
select release_id,models[2],'available',0,'2006-01-01' from audit_provider_context;
select is(public.latest_generation_model_provider_checks(release_id)->1->>'status','available','higher identity wins equal timestamps') from audit_provider_context;
insert into public.generation_model_provider_checks(release_id,model_id,status,consecutive_discrepancies,checked_at)
select release_id,models[2],'error',9,'2005-01-01' from audit_provider_context;
select is(public.latest_generation_model_provider_checks(release_id)->1->>'status','available','timestamp precedes identity for out-of-order imports') from audit_provider_context;

select ok(not (select prosecdef from pg_proc where oid='public.latest_generation_model_provider_checks(uuid)'::regprocedure),'latest lookup is invoker');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.latest_generation_model_provider_checks(uuid)'::regprocedure),'lookup uses empty search path');
select ok(not has_function_privilege('anon','public.latest_generation_model_provider_checks(uuid)','execute'),'anonymous cannot query operational history');
select ok(not has_function_privilege('authenticated','public.latest_generation_model_provider_checks(uuid)','execute'),'authenticated cannot query operational history');
select ok(has_function_privilege('service_role','public.latest_generation_model_provider_checks(uuid)','execute'),'service can query operational history');
grant select on audit_provider_context to service_role;
set local role service_role;
select is(jsonb_array_length(public.latest_generation_model_provider_checks(release_id)),2,'service invoker can read both models with real grants') from audit_provider_context;
reset role;
set local role authenticated;
select throws_ok($$select public.latest_generation_model_provider_checks(null)$$,'42501','permission denied for function latest_generation_model_provider_checks','real authenticated execution is denied');
reset role;

select * from finish();
rollback;

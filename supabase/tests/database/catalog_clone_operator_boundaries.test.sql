begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(22);

create temporary table clone_audit_context as
select r.id as source_id, r.revision as source_revision,
       'audit-clone-' || txid_current()::text as new_revision,
       to_jsonb(r) as source_row,
       (select jsonb_agg(to_jsonb(e)-'release_id'-'created_at'-'updated_at' order by model_id)
        from public.generation_model_catalog_entries e where e.release_id=r.id) as source_entries,
       null::uuid as clone_id, null::bigint as release_count
from public.generation_model_catalog_releases r
where r.status='active'
order by r.schema_version desc limit 1;
grant select, update on clone_audit_context to service_role;

select ok((select count(*)=1 and min(jsonb_array_length(source_entries))>0 from clone_audit_context), 'fixture has an active catalog with entries');
select ok(not (select prosecdef from pg_proc where oid='public.clone_generation_model_catalog(text,text,text,text)'::regprocedure), 'catalog clone remains invoker');
select ok(not has_function_privilege('anon','public.clone_generation_model_catalog(text,text,text,text)','EXECUTE'), 'anonymous clone execution is revoked');
select ok(not has_function_privilege('authenticated','public.clone_generation_model_catalog(text,text,text,text)','EXECUTE'), 'authenticated clone execution is revoked');
select ok(has_function_privilege('service_role','public.clone_generation_model_catalog(text,text,text,text)','EXECUTE'), 'operator service role can clone');
set local role anon;
select throws_ok($$select public.clone_generation_model_catalog('denied-source','audit-denied-anon','fixture','audit')$$, '42501', null, 'anonymous clone call is denied');
reset role;
set local role authenticated;
select throws_ok($$select public.clone_generation_model_catalog('denied-source','audit-denied-user','fixture','audit')$$, '42501', null, 'authenticated clone call is denied');
reset role;
set local role service_role;
select lives_ok($$update clone_audit_context set clone_id=public.clone_generation_model_catalog(source_revision,new_revision,'Rollback-only clone audit','audit-operator')$$, 'service role clones through real table permissions');
reset role;
update clone_audit_context set release_count=(select count(*) from public.generation_model_catalog_releases);

select is((select status from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), 'draft', 'clone is a draft');
select is((select defaults from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), (select source_row->'defaults' from clone_audit_context), 'platform defaults are copied');
select is((select schema_version from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), (select (source_row->>'schema_version')::integer from clone_audit_context), 'source schema version is copied');
select is((select created_by from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), 'audit-operator', 'operator identity is recorded');
select is((select change_note from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), 'Rollback-only clone audit', 'change note is recorded');
select is((select jsonb_agg(to_jsonb(e)-'release_id'-'created_at'-'updated_at' order by model_id) from public.generation_model_catalog_entries e where release_id=(select clone_id from clone_audit_context)), (select source_entries from clone_audit_context), 'all model, adapter, provider, price and validation fields are copied');
select is((select to_jsonb(r) from public.generation_model_catalog_releases r where id=(select source_id from clone_audit_context)), (select source_row from clone_audit_context), 'active source release is unchanged');
select is((select jsonb_agg(to_jsonb(e)-'release_id'-'created_at'-'updated_at' order by model_id) from public.generation_model_catalog_entries e where release_id=(select source_id from clone_audit_context)), (select source_entries from clone_audit_context), 'active source entries are unchanged');
select ok((select activated_at is null and retired_at is null from public.generation_model_catalog_releases where id=(select clone_id from clone_audit_context)), 'clone is neither activated nor retired');
select throws_ok($$select public.clone_generation_model_catalog('audit-missing-source','audit-missing-draft','fixture','audit')$$, 'P0001', 'The source catalog revision does not exist', 'missing source is rejected');
select throws_ok(format('select public.clone_generation_model_catalog(%L,%L,%L,%L)',source_revision,'short','fixture','audit'), 'P0001', 'The new catalog revision is invalid', 'short revision is rejected') from clone_audit_context;
select throws_ok(format('select public.clone_generation_model_catalog(%L,%L,%L,%L)',source_revision,'audit-empty-creator','fixture','   '), 'P0001', 'The catalog creator is required', 'blank operator identity is rejected') from clone_audit_context;
select throws_ok(format('select public.clone_generation_model_catalog(%L,%L,%L,%L)',source_revision,new_revision,'duplicate fixture','audit'), '23505', null, 'duplicate revision is rejected') from clone_audit_context;
select is((select count(*) from public.generation_model_catalog_releases), (select release_count from clone_audit_context), 'rejected clone requests leave no partial release');

select * from finish();
rollback;

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(31);
select ok(not has_function_privilege('anon','public.read_model_catalog_v1_current(text)','EXECUTE'), 'anonymous cannot call catalog RPC');
select ok(not has_function_privilege('authenticated','public.read_model_catalog_v1_page(text,text,numeric,text,integer,text)','EXECUTE'), 'authenticated cannot call page RPC');
select ok(has_function_privilege('service_role','public.read_model_catalog_v1_details(text,text[],text)','EXECUTE'), 'service role can read details');
select is(public.read_model_catalog_v1_page('not-published', null, null, null, 32), null::jsonb, 'unknown revision is unavailable');
select is(public.read_model_catalog_v1_details('not-published', array['model']), null::jsonb, 'unknown detail revision is unavailable');
select throws_ok($$select public.read_model_catalog_v1_page('revision', null, null, null, 52)$$, 'P0001', 'Invalid catalog page arguments', 'page query is bounded');
select throws_ok($$select public.read_model_catalog_v1_page('revision', null, null, null, 32, 'desktop')$$, 'P0001', 'Invalid catalog platform', 'page query rejects unknown platforms');
select throws_ok($$select public.read_model_catalog_v1_current('desktop')$$, 'P0001', 'Invalid catalog platform', 'current query rejects unknown platforms');
select throws_ok($$select public.read_model_catalog_v1_details('revision',array['a','b','c','d','e','f','g','h','i'])$$, 'P0001', 'Expected 1-8 model ids', 'batch query is bounded');
insert into public.generation_model_catalog_releases(revision,schema_version,status,defaults,created_by)
values ('test-shadow-catalog-v1',2,'draft','{"web":{"image":null,"video":null,"motion":null},"mobile":{"image":null,"video":null,"motion":null}}','database-test');
update public.generation_model_catalog_releases set status='shadow' where revision='test-shadow-catalog-v1';
select is(public.read_model_catalog_v1_page('test-shadow-catalog-v1',null,null,null,32),null::jsonb,'shadow pages are not public');
select is(public.read_model_catalog_v1_details('test-shadow-catalog-v1',array['model']),null::jsonb,'shadow details are not public');
select ok(exists(select 1 from pg_indexes where indexname='model_catalog_summary_order_idx'),'ordered summary index exists');
select ok(exists(select 1 from pg_indexes where indexname='model_catalog_kind_order_idx'),'category index exists');

-- Exercise real database keyset reads with equal sort orders, 500 entries, and one web-only entry.
insert into public.generation_models(model_id,kind)
select 'catalog-scale-' || lpad(i::text,4,'0'), 'image' from generate_series(1,500) i;
insert into public.generation_models(model_id,kind) values ('catalog-scale-web-only','image');
insert into public.generation_model_catalog_releases(revision,schema_version,status,defaults,created_by)
values ('catalog-scale-published',2,'draft','{"web":{"image":"catalog-scale-0001","video":null,"motion":null},"mobile":{"image":"catalog-scale-0002","video":null,"motion":null}}','database-test');
insert into public.generation_model_catalog_entries(release_id,model_id,public_descriptor,adapter_key,provider_model_map,pricing_strategy,pricing_config,validation_strategy)
select r.id, m.model_id,
  jsonb_build_object('id',m.model_id,'kind','image','displayName',m.model_id,'description','Model summary','badge',null,'recommended',false,'sortOrder',(substring(m.model_id from 15)::integer / 3),'minClientSchemaVersion',1),
  'image-v1','{"private":"provider-secret"}','image-v1','{"private":"price-secret"}','image-v1'
from public.generation_model_catalog_releases r cross join public.generation_models m
where r.revision='catalog-scale-published' and m.model_id like 'catalog-scale-0%';
insert into public.generation_model_catalog_entries(release_id,model_id,public_descriptor,adapter_key,provider_model_map,pricing_strategy,pricing_config,validation_strategy,web_enabled,mobile_enabled)
select r.id, 'catalog-scale-web-only',
  jsonb_build_object('id','catalog-scale-web-only','kind','image','displayName','Web only','description','Model summary','badge',null,'recommended',false,'sortOrder',999,'minClientSchemaVersion',1),
  'image-v1','{"private":"provider-secret"}','image-v1','{"private":"price-secret"}','image-v1',true,false
from public.generation_model_catalog_releases r where r.revision='catalog-scale-published';

-- The current-revision read sees the active release with each platform's own defaults and counts.
update public.generation_model_catalog_releases set status='retired',retired_at=now() where status='active';
update public.generation_model_catalog_releases set status='active',activated_at=now() where revision='catalog-scale-published';
select is(public.read_model_catalog_v1_current('web') ->> 'revision','catalog-scale-published','current reports the active revision');
select is(public.read_model_catalog_v1_current('web') ->> 'transportVersion','1','current carries the transport version');
select is(public.read_model_catalog_v1_current('web') -> 'defaults' ->> 'image','catalog-scale-0001','current projects the web defaults');
select is(public.read_model_catalog_v1_current('mobile') -> 'defaults' ->> 'image','catalog-scale-0002','current projects the mobile defaults');
select is((public.read_model_catalog_v1_current('web') -> 'counts' ->> 'image')::integer,501,'web counts include web-only models');
select is((public.read_model_catalog_v1_current('mobile') -> 'counts' ->> 'image')::integer,500,'mobile counts exclude web-only models');
select is((public.read_model_catalog_v1_current() -> 'counts' ->> 'video')::integer,0,'counts are zero for empty categories');
update public.generation_model_catalog_releases set status='retired',retired_at=now() where revision='catalog-scale-published';
select is(public.read_model_catalog_v1_current('web'),null::jsonb,'no active release reads as unavailable');

create function pg_temp.all_catalog_ids(platform text) returns text[] language plpgsql as $$
declare page jsonb; last_row jsonb; ids text[] := '{}'; last_sort numeric; last_id text;
begin
  loop
    page := public.read_model_catalog_v1_page('catalog-scale-published','image',last_sort,last_id,32,platform);
    if jsonb_array_length(page)=0 then exit; end if;
    ids := ids || array(select item->>'id' from jsonb_array_elements(page) item);
    last_row := page->(jsonb_array_length(page)-1);
    last_sort := (last_row->>'sortOrder')::numeric;
    last_id := last_row->>'id';
    if cardinality(ids)>501 then raise exception 'Pagination repeated models'; end if;
  end loop;
  return ids;
end $$;
select is(cardinality(pg_temp.all_catalog_ids('web')),501,'all published web models are discoverable');
select is(cardinality(pg_temp.all_catalog_ids('mobile')),500,'mobile pages exclude web-only models');
select is((select count(distinct id)::integer from unnest(pg_temp.all_catalog_ids('web')) id),501,'ties produce no duplicate IDs');
select is(jsonb_array_length(public.read_model_catalog_v1_page('catalog-scale-published','video',null,null,32)),0,'category filters are exact');
select ok(octet_length(public.read_model_catalog_v1_page('catalog-scale-published',null,null,null,50)::text)<=16384,'50-model SQL summary page meets its UTF-8 ceiling');
select ok(public.read_model_catalog_v1_page('catalog-scale-published',null,null,null,50)::text !~ 'provider-secret|price-secret|controls','summary projection contains no private configuration or controls');
select is(jsonb_array_length(public.read_model_catalog_v1_details('catalog-scale-published',array['catalog-scale-0001','catalog-scale-0500','missing'])),2,'detail query selects exactly requested available IDs');
select is(jsonb_array_length(public.read_model_catalog_v1_details('catalog-scale-published',array['catalog-scale-web-only'],'mobile')),0,'mobile details exclude web-only models');
select is(public.read_model_catalog_v1_details('catalog-scale-published',array['catalog-scale-web-only'],'web') -> 0 ->> 'mobileEnabled','false','web details report both availability flags');
select ok(public.read_model_catalog_v1_details('catalog-scale-published',array['catalog-scale-0001'])::text !~ 'provider-secret|price-secret','detail projection contains no private configuration');
select * from finish();
rollback;

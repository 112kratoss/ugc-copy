begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(10);

insert into auth.users(id,email,aud,role,created_at)
values ('e88f0001-0000-4000-8000-000000000001','restore-quality@example.invalid','authenticated','authenticated',now());
update public.profiles set username='restore-quality',display_name='Restore Quality'
where id='e88f0001-0000-4000-8000-000000000001';
insert into public.posts(id,user_id,visibility,category,source_kind,review_status,post_format,title,body)
select id,'e88f0001-0000-4000-8000-000000000001','public','text','external','visible','text','Restore fixture','A body long enough to read as real public content.'
from unnest(array['e88f0002-0000-4000-8000-000000000001'::uuid,'e88f0002-0000-4000-8000-000000000002'::uuid]) id;
insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,summary,preview_text,prompt_text,price_usd_cents)
values
 ('e88f0003-0000-4000-8000-000000000001','e88f0002-0000-4000-8000-000000000001','e88f0001-0000-4000-8000-000000000001','free','published','Valid recipe','Anyone can use this recipe.','A preview long enough to satisfy the marketplace quality gate.','A free prompt that is long enough to count as a real resource.',0),
 ('e88f0003-0000-4000-8000-000000000002','e88f0002-0000-4000-8000-000000000002','e88f0001-0000-4000-8000-000000000001','free','draft','Draft recipe','This is an unfinished recipe.','A preview long enough to satisfy the marketplace quality gate.','short',0);
update public.posts set archived_at=now() where id='e88f0002-0000-4000-8000-000000000002';

select ok(has_function_privilege('service_role','public.post_resource_bundle_quality_issue_for(uuid)','EXECUTE'),'service can evaluate the exposure quality gate');
select ok(not has_function_privilege('anon','public.post_resource_bundle_quality_issue_for(uuid)','EXECUTE'),'anonymous clients cannot evaluate private bundle metadata');
select ok(not has_function_privilege('authenticated','public.post_resource_bundle_quality_issue_for(uuid)','EXECUTE'),'authenticated clients cannot evaluate private bundle metadata');

-- PostgREST runs direct post updates under this role, not postgres.
set local role service_role;
select lives_ok($$update public.posts set archived_at=now() where id='e88f0002-0000-4000-8000-000000000001'$$,'service archives a recipe post');
select is((select status from public.post_resource_bundles where id='e88f0003-0000-4000-8000-000000000001'),'draft','archive demotes its recipe in the same statement');
select lives_ok($$update public.posts set archived_at=null where id='e88f0002-0000-4000-8000-000000000001'$$,'service restores a valid recipe post');
select is((select status from public.post_resource_bundles where id='e88f0003-0000-4000-8000-000000000001'),'published','restore republishes the valid recipe');
select lives_ok($$update public.posts set archived_at=null where id='e88f0002-0000-4000-8000-000000000002'$$,'service restores an unfinished recipe post');
select is((select status from public.post_resource_bundles where id='e88f0003-0000-4000-8000-000000000002'),'draft','unfinished recipe is not published');
select ok((select archived_at is null from public.posts where id='e88f0002-0000-4000-8000-000000000002'),'unfinished recipe does not prevent restoring its post');
reset role;
select * from finish();
rollback;

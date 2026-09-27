-- Client RPC boundaries: isolated fixtures, no committed worker tickets.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select is((select string_agg(p.proname, ',' order by p.proname)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef
    and has_function_privilege('authenticated',p.oid,'EXECUTE')),
  'current_identity_admission,current_identity_is_active,current_identity_is_registered,current_identity_state,initialize_workflow_canvas_run,start_workflow_canvas_run',
  'only the reviewed six privileged public functions are client callable');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef and has_function_privilege('anon',p.oid,'EXECUTE')),
  0::bigint,'no privileged public function is callable without authentication');
select ok(not has_schema_privilege('authenticated','public','CREATE'),
  'clients cannot shadow names in the public function search path');

insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e7100001-0000-4000-8000-000000000001','rpc-e7100001@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions(id,user_id,created_at,updated_at) values('e7100001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001',now(),now());
insert into public.workflow_canvases(id,user_id,title,graph) values('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','RPC rollback fixture','{"version":1,"nodes":[],"edges":[]}');
insert into auth.users(id,email,aud,role,is_anonymous,created_at) values('e7100002-0000-4000-8000-000000000002','rpc-e7100002@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions(id,user_id,created_at,updated_at) values('e7100002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002',now(),now());
insert into public.workflow_canvases(id,user_id,title,graph) values('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','RPC rollback fixture','{"version":1,"nodes":[],"edges":[]}');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e7100001-0000-4000-8000-000000000001"}',true);
select is(public.current_identity_state(),'active','identity state is current subject');
select is(public.current_identity_is_active(),true,'live owner admitted');
select is(public.current_identity_is_registered(),true,'registered owner identified');
select is((public.current_identity_admission()->>'session_valid')::boolean,true,'current subject session checked');
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','blocked', '[{"nodeId":"start"}]')$q$,'P0001','cannot start a workflow run for another user','initialize: forged subject denied');
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked', '[{"nodeId":"start"}]')$q$,'P0001','workflow canvas not found for this user','initialize: foreign canvas denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','blocked')$q$,'P0001','cannot start a workflow run for another user','start: forged subject denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked')$q$,'P0001','workflow canvas not found for this user','start: foreign canvas denied');
do $b$ begin for i in 1..20 loop perform * from public.initialize_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','rpc-'||i,'[{"nodeId":"start"}]'); end loop; end; $b$;
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked', '[{"nodeId":"start"}]')$q$,'P0001','workflow run rate limit exceeded','initializer rejects 21st direct start');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked')$q$,'P0001','legacy workflow run rate limit exceeded','switching to legacy cannot bypass shared limit');
reset role;
select is((select count(*) from public.workflow_canvas_runs where user_id='e7100001-0000-4000-8000-000000000001'),20::bigint,'denial leaves exactly twenty runs');
select is((select count(*) from public.workflow_run_step_jobs where canvas_id='e7200001-0000-4000-8000-000000000001'),20::bigint,'denial creates no worker ticket');
select is((select request_count from public.backend_rate_limits where scope='workflow-run:start' and subject_key='e7100001-0000-4000-8000-000000000001'),20,'direct initializer shares API admission counter');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100002-0000-4000-8000-000000000002","role":"authenticated","session_id":"e7100002-0000-4000-8000-000000000002"}',true);
select ok((select not reused from (select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','other', '[{"nodeId":"start"}]')) q),'another owner has an independent quota');
reset role;
delete from auth.sessions where id='e7100002-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100002-0000-4000-8000-000000000002","role":"authenticated","session_id":"e7100002-0000-4000-8000-000000000002"}',true);
select is(public.current_identity_is_active(),false,'revoked: active identity result');
select is(public.current_identity_is_registered(),true,'revoked: registration independently reported');
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','revoked', '[{"nodeId":"start"}]')$q$,'42501','Active identity required','revoked: initialize denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','revoked')$q$,'42501','Active identity required','revoked: start denied');
reset role;
insert into auth.sessions(id,user_id,created_at,updated_at) values('e7100002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002',now(),now());
update auth.users set banned_until=now()+interval '1 hour' where id='e7100002-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100002-0000-4000-8000-000000000002","role":"authenticated","session_id":"e7100002-0000-4000-8000-000000000002"}',true);
select is(public.current_identity_is_active(),false,'banned: active identity result');
select is(public.current_identity_is_registered(),true,'banned: registration independently reported');
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','banned', '[{"nodeId":"start"}]')$q$,'42501','Active identity required','banned: initialize denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','banned')$q$,'42501','Active identity required','banned: start denied');
reset role;
update auth.users set banned_until=null where id='e7100002-0000-4000-8000-000000000002';
update auth.users set is_anonymous=true where id='e7100002-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100002-0000-4000-8000-000000000002","role":"authenticated","session_id":"e7100002-0000-4000-8000-000000000002"}',true);
select is(public.current_identity_is_active(),true,'guest: active identity result');
select is(public.current_identity_is_registered(),false,'guest: registration independently reported');
select ok((select not reused from (select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','guest', '[{"nodeId":"start"}]')) q),'live guest retains workflow compatibility');
reset role;
update auth.users set is_anonymous=false where id='e7100002-0000-4000-8000-000000000002';
update public.profiles set identity_state='deleting' where id='e7100002-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e7100002-0000-4000-8000-000000000002","role":"authenticated","session_id":"e7100002-0000-4000-8000-000000000002"}',true);
select is(public.current_identity_is_active(),false,'deleting: active identity result');
select is(public.current_identity_is_registered(),true,'deleting: registration independently reported');
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','deleting', '[{"nodeId":"start"}]')$q$,'42501','Active identity required','deleting: initialize denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200002-0000-4000-8000-000000000002','e7100002-0000-4000-8000-000000000002','start','node',null,'{}','deleting')$q$,'42501','Active identity required','deleting: start denied');
reset role;

reset role;
set local role anon;
select throws_ok($q$select * from public.initialize_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked', '[{"nodeId":"start"}]')$q$,'42501',null,'anon: initialize execute denied');
select throws_ok($q$select * from public.start_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','blocked')$q$,'42501',null,'anon: start execute denied');
select throws_ok($q$select public.current_identity_admission()$q$,'42501',null,'anon: current_identity_admission execute denied');
select throws_ok($q$select public.current_identity_state()$q$,'42501',null,'anon: current_identity_state execute denied');
select throws_ok($q$select public.current_identity_is_active()$q$,'42501',null,'anon: current_identity_is_active execute denied');
select throws_ok($q$select public.current_identity_is_registered()$q$,'42501',null,'anon: current_identity_is_registered execute denied');
reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select ok((select not reused from (select * from public.initialize_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','service', '[{"nodeId":"start"}]')) q),'service initializer is not double charged after API admission');
select ok((select reused from (select * from public.initialize_workflow_canvas_run('e7200001-0000-4000-8000-000000000001','e7100001-0000-4000-8000-000000000001','start','node',null,'{}','service', '[{"nodeId":"start"}]')) q),'service retry reuses run and ticket');
reset role;
select is((select request_count from public.backend_rate_limits where scope='workflow-run:start' and subject_key='e7100001-0000-4000-8000-000000000001'),20,'service mutation preserves API counter');
select * from finish();
rollback;

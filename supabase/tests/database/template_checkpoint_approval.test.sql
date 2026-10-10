begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(16);
select ok(not has_function_privilege('anon','public.approve_template_checkpoint(uuid,uuid,uuid)','EXECUTE'), 'anonymous cannot approve');
select ok(not has_function_privilege('authenticated','public.approve_template_checkpoint(uuid,uuid,uuid)','EXECUTE'), 'authenticated cannot call internal approval');
select ok(has_function_privilege('service_role','public.approve_template_checkpoint(uuid,uuid,uuid)','EXECUTE'), 'service role can approve');
select ok(not (select prosecdef from pg_proc where oid='public.approve_template_checkpoint(uuid,uuid,uuid)'::regprocedure), 'approval does not elevate caller privileges');
insert into auth.users(id,email,aud,role,created_at) values
 ('e8100000-0000-4000-8000-000000000001','approval-audit@example.invalid','authenticated','authenticated',now());
insert into public.templates(id,name,creator_user_id,status,is_active) values
 ('e8200000-0000-4000-8000-000000000001','Approval fixture','e8100000-0000-4000-8000-000000000001','draft',true);
insert into public.template_runs(id,template_id,user_id,graph_snapshot,graph_hash,input_manifest,input_storage_paths,output_node_id,output_kind,status,estimated_total_credits,estimated_remaining_credits) values
 ('e8300000-0000-4000-8000-000000000001','e8200000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001','{}',repeat('a',64),'[]','{}','output','image','awaiting_approval',10,10);
insert into public.template_run_steps(id,run_id,node_id,kind,media_kind,label,status,output_url,estimated_credits) values
 ('e8400000-0000-4000-8000-000000000001','e8300000-0000-4000-8000-000000000001','gate','approval','image','Gate','awaiting_approval','https://storage.test/result.png',0);
set local role service_role;
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000002'),'RUN_NOT_FOUND','foreign caller cannot approve');
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000002','e8100000-0000-4000-8000-000000000001'),'STEP_NOT_FOUND','foreign step cannot approve');
update public.template_run_steps set output_url=null where id='e8400000-0000-4000-8000-000000000001';
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001'),'APPROVAL_NOT_READY','missing output cannot approve');
update public.template_run_steps set output_url='https://storage.test/result.png' where id='e8400000-0000-4000-8000-000000000001';
insert into public.template_run_steps(id,run_id,node_id,attempt,kind,media_kind,label,status,estimated_credits) values
 ('e8400000-0000-4000-8000-000000000002','e8300000-0000-4000-8000-000000000001','gate',1,'approval','image','Next gate','queued',0);
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001'),'STALE_STEP_ATTEMPT','replaced checkpoint cannot approve');
delete from public.template_run_steps where id='e8400000-0000-4000-8000-000000000002';
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001'),'approved','owned checkpoint approves');
select is((select status from public.template_runs where id='e8300000-0000-4000-8000-000000000001'),'processing','run resumes');
select is((select status from public.template_run_steps where id='e8400000-0000-4000-8000-000000000001'),'succeeded','checkpoint succeeds');
select ok((select approved_at is not null and approved_at=finished_at from public.template_run_steps where id='e8400000-0000-4000-8000-000000000001'),'approval timestamps recorded together');
select is((select count(*) from public.template_run_jobs where run_id='e8300000-0000-4000-8000-000000000001' and status='pending'),1::bigint,'approval creates durable pending execution');
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001'),'APPROVAL_NOT_READY','duplicate approval is refused');
update public.template_runs set status='cancelled' where id='e8300000-0000-4000-8000-000000000001';
select is(public.approve_template_checkpoint('e8300000-0000-4000-8000-000000000001','e8400000-0000-4000-8000-000000000001','e8100000-0000-4000-8000-000000000001'),'RUN_TERMINAL','cancelled run stays ended');
select is((select count(*) from public.generations where user_id='e8100000-0000-4000-8000-000000000001'),0::bigint,'approval itself starts no paid generation');
reset role;
select * from finish();
rollback;

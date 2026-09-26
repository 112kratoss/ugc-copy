-- Direct Data API ownership checks, including self-owned rows with foreign parents.
-- Every fixture and attempted write is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id,email,aud,role,raw_app_meta_data,raw_user_meta_data,created_at)
values ('e2100000-0000-4000-8000-000000000001','table-owner@example.invalid','authenticated','authenticated','{}','{}',now()),
       ('e2110000-0000-4000-8000-000000000002','table-other@example.invalid','authenticated','authenticated','{}','{}',now());
insert into auth.sessions (id,user_id,created_at,updated_at) values
('e2900000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001',now(),now());
insert into public.workflow_canvases (id,user_id,title,graph) values
('e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','Owner canvas','{}'),
('e2200000-0000-4000-8000-000000000002','e2110000-0000-4000-8000-000000000002','Other canvas','{}'),
('e2200000-0000-4000-8000-000000000003','e2100000-0000-4000-8000-000000000001','Second owner canvas','{}');
insert into public.workflow_canvas_assistant_proposals (id,canvas_id,user_id,summary,proposed_graph) values
('e2300000-0000-4000-8000-000000000001','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','Own proposal','{}'),
('e2300000-0000-4000-8000-000000000002','e2200000-0000-4000-8000-000000000002','e2110000-0000-4000-8000-000000000002','Other proposal','{}'),
('e2300000-0000-4000-8000-000000000003','e2200000-0000-4000-8000-000000000003','e2100000-0000-4000-8000-000000000001','Other canvas proposal','{}');
insert into public.generations (id,user_id,model,status,is_public) values
('e2400000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','test-model','succeeded',false),
('e2400000-0000-4000-8000-000000000002','e2110000-0000-4000-8000-000000000002','test-model','succeeded',false);
insert into public.workflow_canvas_runs (id,canvas_id,user_id,start_node_id,mode)
values ('e2500000-0000-4000-8000-000000000001','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','seed','node');
-- Deliberately inconsistent legacy data is invisible to client roles.
insert into public.workflow_canvas_history (id,canvas_id,user_id,title,graph,kind)
values ('e2600000-0000-4000-8000-000000000001','e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','Snapshot','{}','draft');
-- Deliberately inconsistent legacy data is invisible to client roles.
insert into public.workflow_canvas_runs (id,canvas_id,user_id,start_node_id,mode,status)
values ('e2600000-0000-4000-8000-000000000002','e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','node','node','processing');
-- Deliberately inconsistent legacy data is invisible to client roles.
insert into public.workflow_canvas_assistant_proposals (id,canvas_id,user_id,summary,proposed_graph)
values ('e2600000-0000-4000-8000-000000000003','e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','Proposal','{}');
-- Deliberately inconsistent legacy data is invisible to client roles.
insert into public.workflow_canvas_assistant_messages (id,canvas_id,user_id,role,content)
values ('e2600000-0000-4000-8000-000000000004','e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','user','Message');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e2100000-0000-4000-8000-000000000001","role":"authenticated","session_id":"e2900000-0000-4000-8000-000000000001"}',true);
select ok(public.current_identity_is_active(), 'fixture identity passes the active identity gate');

select lives_ok($$ insert into public.workflow_canvas_history (id,canvas_id,user_id,title,graph,kind)
values ('e2700000-0000-4000-8000-000000000001','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','Snapshot','{}','draft') $$,
'workflow_canvas_history: owner can create a child on their own canvas');
select throws_ok($$ insert into public.workflow_canvas_history (canvas_id,user_id,title,graph,kind)
values ('e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','Snapshot','{}','draft') $$, '42501', null,
'workflow_canvas_history: self-owned child cannot target another owner canvas');
select is((select count(*) from public.workflow_canvas_history where id='e2600000-0000-4000-8000-000000000001'),0::bigint,
'workflow_canvas_history: inconsistent legacy child is hidden');
select is((select count(*) from public.workflow_canvas_history where id='e2700000-0000-4000-8000-000000000001'),1::bigint,
'workflow_canvas_history: valid own child remains readable');

select lives_ok($$ insert into public.workflow_canvas_runs (id,canvas_id,user_id,start_node_id,mode,status)
values ('e2700000-0000-4000-8000-000000000002','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','node','node','processing') $$,
'workflow_canvas_runs: owner can create a child on their own canvas');
select throws_ok($$ insert into public.workflow_canvas_runs (canvas_id,user_id,start_node_id,mode,status)
values ('e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','node','node','processing') $$, '42501', null,
'workflow_canvas_runs: self-owned child cannot target another owner canvas');
select is((select count(*) from public.workflow_canvas_runs where id='e2600000-0000-4000-8000-000000000002'),0::bigint,
'workflow_canvas_runs: inconsistent legacy child is hidden');
select is((select count(*) from public.workflow_canvas_runs where id='e2700000-0000-4000-8000-000000000002'),1::bigint,
'workflow_canvas_runs: valid own child remains readable');

select throws_ok($$ update public.workflow_canvas_runs set canvas_id='e2200000-0000-4000-8000-000000000002' where id='e2700000-0000-4000-8000-000000000002' $$,'42501',null,
'workflow_canvas_runs: cannot move an existing child onto a foreign canvas');
select lives_ok($$ update public.workflow_canvas_runs set canvas_id='e2200000-0000-4000-8000-000000000003' where id='e2700000-0000-4000-8000-000000000002' $$,
'workflow_canvas_runs: can move an unlinked child between own canvases');

select lives_ok($$ insert into public.workflow_canvas_assistant_proposals (id,canvas_id,user_id,summary,proposed_graph)
values ('e2700000-0000-4000-8000-000000000003','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','Proposal','{}') $$,
'workflow_canvas_assistant_proposals: owner can create a child on their own canvas');
select throws_ok($$ insert into public.workflow_canvas_assistant_proposals (canvas_id,user_id,summary,proposed_graph)
values ('e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','Proposal','{}') $$, '42501', null,
'workflow_canvas_assistant_proposals: self-owned child cannot target another owner canvas');
select is((select count(*) from public.workflow_canvas_assistant_proposals where id='e2600000-0000-4000-8000-000000000003'),0::bigint,
'workflow_canvas_assistant_proposals: inconsistent legacy child is hidden');
select is((select count(*) from public.workflow_canvas_assistant_proposals where id='e2700000-0000-4000-8000-000000000003'),1::bigint,
'workflow_canvas_assistant_proposals: valid own child remains readable');

select throws_ok($$ update public.workflow_canvas_assistant_proposals set canvas_id='e2200000-0000-4000-8000-000000000002' where id='e2700000-0000-4000-8000-000000000003' $$,'42501',null,
'workflow_canvas_assistant_proposals: cannot move an existing child onto a foreign canvas');
select lives_ok($$ update public.workflow_canvas_assistant_proposals set canvas_id='e2200000-0000-4000-8000-000000000003' where id='e2700000-0000-4000-8000-000000000003' $$,
'workflow_canvas_assistant_proposals: can move an unlinked child between own canvases');

select lives_ok($$ insert into public.workflow_canvas_assistant_messages (id,canvas_id,user_id,role,content)
values ('e2700000-0000-4000-8000-000000000004','e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','user','Message') $$,
'workflow_canvas_assistant_messages: owner can create a child on their own canvas');
select throws_ok($$ insert into public.workflow_canvas_assistant_messages (canvas_id,user_id,role,content)
values ('e2200000-0000-4000-8000-000000000002','e2100000-0000-4000-8000-000000000001','user','Message') $$, '42501', null,
'workflow_canvas_assistant_messages: self-owned child cannot target another owner canvas');
select is((select count(*) from public.workflow_canvas_assistant_messages where id='e2600000-0000-4000-8000-000000000004'),0::bigint,
'workflow_canvas_assistant_messages: inconsistent legacy child is hidden');
select is((select count(*) from public.workflow_canvas_assistant_messages where id='e2700000-0000-4000-8000-000000000004'),1::bigint,
'workflow_canvas_assistant_messages: valid own child remains readable');

select throws_ok($$ update public.workflow_canvas_assistant_messages set canvas_id='e2200000-0000-4000-8000-000000000002' where id='e2700000-0000-4000-8000-000000000004' $$,'42501',null,
'workflow_canvas_assistant_messages: cannot move an existing child onto a foreign canvas');
select lives_ok($$ update public.workflow_canvas_assistant_messages set canvas_id='e2200000-0000-4000-8000-000000000003' where id='e2700000-0000-4000-8000-000000000004' $$,
'workflow_canvas_assistant_messages: can move an unlinked child between own canvases');

select lives_ok($$ insert into public.workflow_canvas_assistant_messages (canvas_id,user_id,role,content,proposal_id)
values ('e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','assistant','Valid linked message','e2300000-0000-4000-8000-000000000001') $$,
'messages can link a proposal belonging to the same owner and canvas');
select throws_ok($$ insert into public.workflow_canvas_assistant_messages (canvas_id,user_id,role,content,proposal_id)
values ('e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','assistant','Forged other-owner link','e2300000-0000-4000-8000-000000000002') $$,'42501',null,
'messages cannot link another owner proposal');
select throws_ok($$ insert into public.workflow_canvas_assistant_messages (canvas_id,user_id,role,content,proposal_id)
values ('e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','assistant','Forged other-canvas link','e2300000-0000-4000-8000-000000000003') $$,'42501',null,
'messages cannot link an own proposal from a different canvas');
select throws_ok($$ update public.workflow_canvas_assistant_messages set proposal_id='e2300000-0000-4000-8000-000000000002'
where id='e2700000-0000-4000-8000-000000000004' $$,'42501',null,
'message updates cannot attach another owner proposal');
select lives_ok($$ insert into public.workflow_canvas_run_steps (id,run_id,node_id,status,generation_id)
values ('e2800000-0000-4000-8000-000000000001','e2500000-0000-4000-8000-000000000001','own-generation','succeeded','e2400000-0000-4000-8000-000000000001') $$,
'run steps can link the owner generation');
select lives_ok($$ insert into public.workflow_canvas_run_steps (run_id,node_id,status)
values ('e2500000-0000-4000-8000-000000000001','no-generation','queued') $$,
'queued steps can omit a generation');
select throws_ok($$ insert into public.workflow_canvas_run_steps (run_id,node_id,status,generation_id)
values ('e2500000-0000-4000-8000-000000000001','foreign-generation','succeeded','e2400000-0000-4000-8000-000000000002') $$,'42501',null,
'run steps cannot link another owner generation');
select throws_ok($$ update public.workflow_canvas_run_steps set generation_id='e2400000-0000-4000-8000-000000000002'
where id='e2800000-0000-4000-8000-000000000001' $$,'42501',null,
'step updates cannot attach another owner generation');
-- The new policies must still compose with the active-session boundary.
reset role;
delete from auth.sessions where id='e2900000-0000-4000-8000-000000000001';
set local role authenticated;
select is(public.current_identity_is_active(),false,'revoked session remains denied');
select is((select count(*) from public.workflow_canvas_history),0::bigint,'workflow_canvas_history: revoked session cannot read rows');
select is((select count(*) from public.workflow_canvas_runs),0::bigint,'workflow_canvas_runs: revoked session cannot read rows');
select is((select count(*) from public.workflow_canvas_assistant_proposals),0::bigint,'workflow_canvas_assistant_proposals: revoked session cannot read rows');
select is((select count(*) from public.workflow_canvas_assistant_messages),0::bigint,'workflow_canvas_assistant_messages: revoked session cannot read rows');
select is((select count(*) from public.workflow_canvas_run_steps),0::bigint,'workflow_canvas_run_steps: revoked session cannot read rows');
select throws_ok($$ insert into public.workflow_canvas_runs (canvas_id,user_id,start_node_id,mode)
values ('e2200000-0000-4000-8000-000000000001','e2100000-0000-4000-8000-000000000001','revoked','node') $$,'42501',null,
'revoked session cannot create a run even with a matching parent');
reset role;
select set_config('request.jwt.claims','{}',true);
set local role service_role;
select lives_ok($$ update public.workflow_canvas_run_steps set status='succeeded'
where id='e2800000-0000-4000-8000-000000000001' $$,'service-role completion jobs retain step update access');
select is((select count(*) from public.workflow_canvases),3::bigint,'service role retains cross-owner access for trusted operations');
reset role;
select * from finish();
rollback;

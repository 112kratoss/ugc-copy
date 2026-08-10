-- Behavioural coverage for the F12 atomic workflow-run initializer.
--
-- The TypeScript migration test pins source shape. These assertions prove the
-- database properties the release depends on: caller binding, a required key,
-- one run + complete skeleton + first ticket in one transaction, and replay
-- without graph/step/job duplication. The legacy run-only RPC intentionally
-- remains compatible for one schema-first release window.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('a1000000-0000-4000-8000-000000000001'::uuid, 'workflow-owner@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('a2000000-0000-4000-8000-000000000002'::uuid, 'workflow-other@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.workflow_canvases (id, user_id, title, graph)
values (
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'Atomic workflow fixture',
  '{"version":1,"nodes":[],"edges":[]}'::jsonb
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.initialize_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated callers can execute the supported atomic initializer'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.initialize_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the atomic initializer'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.start_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text)',
    'EXECUTE'
  ),
  'the old run-only RPC remains available for the one-release rollout window'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select * from public.initialize_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'start', 'branch', null, '{}'::jsonb, null,
      '[{"nodeId":"start"}]'::jsonb
    )
  $$,
  'P0001',
  'idempotency_key is required',
  'the atomic initializer rejects a keyless run'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select * from public.initialize_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'start', 'branch', null, '{}'::jsonb, 'foreign-user-key',
      '[{"nodeId":"start"}]'::jsonb
    )
  $$,
  'P0001',
  'cannot start a workflow run for another user',
  'the definer initializer derives and enforces the authenticated caller'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

create temporary table first_initialization as
select * from public.initialize_workflow_canvas_run(
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'start',
  'branch',
  'cert-revision',
  '{"version":1,"nodes":[{"id":"start"},{"id":"image"},{"id":"video"}],"edges":[]}'::jsonb,
  'atomic-key-1',
  '[
    {"nodeId":"start","inputSnapshot":{"prompt":"hello"}},
    {"nodeId":"image"},
    {"nodeId":"video"}
  ]'::jsonb
);

select is((select reused from first_initialization), false, 'the first initialization is not a replay');
select ok((select job_id is not null from first_initialization), 'the first initialization returns its durable ticket');

select is(
  (select count(*) from public.workflow_canvas_runs where idempotency_key = 'atomic-key-1'),
  1::bigint,
  'the initializer creates exactly one run'
);

select is(
  (select count(*) from public.workflow_canvas_run_steps
   where run_id = (select run_id from first_initialization)),
  3::bigint,
  'the initializer creates the complete step skeleton'
);

select is(
  (select count(*) from public.workflow_canvas_run_steps
   where run_id = (select run_id from first_initialization) and status = 'queued'),
  3::bigint,
  'every initial step is queued before provider work begins'
);

select is(
  (select count(*) from public.workflow_run_step_jobs
   where run_id = (select run_id from first_initialization)
     and node_id = 'start' and attempt = 1 and status = 'pending'),
  1::bigint,
  'the initializer creates exactly one first-attempt durable ticket'
);

select is(
  (select input_snapshot->>'prompt' from public.workflow_canvas_run_steps
   where run_id = (select run_id from first_initialization) and node_id = 'start'),
  'hello',
  'the step skeleton preserves object input snapshots'
);

create temporary table replay_initialization as
select * from public.initialize_workflow_canvas_run(
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'start', 'branch', 'different-revision',
  '{"version":1,"nodes":[{"id":"different"}],"edges":[]}'::jsonb,
  'atomic-key-1',
  '[{"nodeId":"different"}]'::jsonb
);

select is((select reused from replay_initialization), true, 'the second initialization reports an idempotent replay');
select is(
  (select run_id from replay_initialization),
  (select run_id from first_initialization),
  'a replay returns the original run identity'
);
select is(
  (select count(*) from public.workflow_canvas_runs where idempotency_key = 'atomic-key-1'),
  1::bigint,
  'a replay does not create a second run'
);
select is(
  (select count(*) from public.workflow_canvas_run_steps
   where run_id = (select run_id from first_initialization)),
  3::bigint,
  'a replay does not replace or duplicate the original skeleton'
);
select is(
  (select count(*) from public.workflow_run_step_jobs
   where run_id = (select run_id from first_initialization)),
  1::bigint,
  'a replay does not create a second ticket'
);

select throws_ok(
  $$
    select * from public.initialize_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'duplicate', 'branch', null, '{}'::jsonb, 'duplicate-key',
      '[{"nodeId":"duplicate"},{"nodeId":"duplicate"}]'::jsonb
    )
  $$,
  'P0001',
  'step_skeleton contains duplicate node ids',
  'duplicate node ids cannot weaken the run/node uniqueness invariant'
);

select lives_ok(
  $$
    select * from public.start_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'start', 'node', null, '{}'::jsonb, null
    )
  $$,
  'the previous app can still perform a keyless start during schema-first rollout'
);

select is(
  (select count(*) from public.workflow_canvas_runs where idempotency_key is null),
  1::bigint,
  'the compatibility call creates one legacy run row'
);

select is(
  (select count(*)
   from public.workflow_run_step_jobs jobs
   join public.workflow_canvas_runs runs on runs.id = jobs.run_id
   where runs.idempotency_key is null),
  0::bigint,
  'the compatibility RPC remains run-only and is not mistaken for atomic ownership'
);

select * from finish();
rollback;

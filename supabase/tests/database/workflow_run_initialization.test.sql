-- Behavioural coverage for the F12 atomic workflow-run initializer.
--
-- The TypeScript migration test pins source shape. These assertions prove the
-- database properties the compatibility release depends on: a required key,
-- one run + complete skeleton + first ticket in one transaction, replay
-- without graph/step/job duplication, and an internal limit on the legacy RPC.
-- Direct authenticated writes remain until the deferred stage-3 contraction.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

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
  'the compatibility release keeps the authenticated initializer grant for the previously deployed app'
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
    'service_role',
    'public.initialize_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text,jsonb)',
    'EXECUTE'
  ),
  'the service role can execute the supported atomic initializer'
);

select ok(
  to_regprocedure('public.start_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text)') is not null
    and has_function_privilege(
      'authenticated',
      'public.start_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text)',
      'EXECUTE'
    ),
  'the legacy starter remains callable during the compatibility window'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.start_workflow_canvas_run(uuid,uuid,text,text,text,jsonb,text)',
    'EXECUTE'
  ),
  'anonymous callers cannot reach the compatibility starter'
);

select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'SELECT'),
  'authenticated callers retain owner-scoped run reads'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'SELECT'),
  'authenticated callers retain owner-scoped step reads'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'INSERT'),
  'the compatibility release preserves authenticated run inserts'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'UPDATE'),
  'the compatibility release preserves authenticated run updates'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'INSERT'),
  'the compatibility release preserves authenticated step inserts'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'UPDATE'),
  'the compatibility release preserves authenticated step updates'
);

delete from public.backend_rate_limits
where scope = 'legacy-workflow-run-start';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$
    select * from public.initialize_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'compat-start', 'branch', null, '{}'::jsonb, 'compat-client-key',
      '[{"nodeId":"start"}]'::jsonb
    )
  $$,
  'the previously deployed authenticated initializer call survives schema-first rollout'
);

select lives_ok(
  $$
    insert into public.workflow_canvas_runs (
      canvas_id, user_id, start_node_id, mode, status, graph_snapshot
    ) values (
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'forged', 'node', 'processing', '{}'::jsonb
    )
  $$,
  'the previous app direct-run compatibility grant remains until stage 3'
);

select lives_ok(
  $$
    update public.workflow_canvas_run_steps
    set status = 'failed'
    where false
  $$,
  'the previous app direct-step compatibility grant remains until stage 3'
);

select lives_ok(
  $test$
    do $body$
    begin
      for rate_index in 1..20 loop
        perform * from public.start_workflow_canvas_run(
          'b1000000-0000-4000-8000-000000000001'::uuid,
          'a1000000-0000-4000-8000-000000000001'::uuid,
          'legacy-start', 'branch', null, '{}'::jsonb,
          format('legacy-rate-%s', rate_index)
        );
      end loop;
    end
    $body$
  $test$,
  'the legacy boundary admits the first twenty starts in its ten-minute window'
);

select throws_ok(
  $$
    select * from public.start_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'legacy-start', 'branch', null, '{}'::jsonb, 'legacy-rate-21'
    )
  $$,
  'P0001',
  'legacy workflow run rate limit exceeded',
  'the twenty-first direct legacy RPC call is rejected inside the database boundary'
);

reset role;
select set_config('request.jwt.claims', '{}', true);
set local role service_role;

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
  'the atomic initializer rejects a keyless service request'
);

select throws_ok(
  $$
    select * from public.initialize_workflow_canvas_run(
      'b1000000-0000-4000-8000-000000000001'::uuid,
      'a2000000-0000-4000-8000-000000000002'::uuid,
      'start', 'branch', null, '{}'::jsonb, 'foreign-user-key',
      '[{"nodeId":"start"}]'::jsonb
    )
  $$,
  'P0001',
  'workflow canvas not found for this user',
  'the definer initializer binds the supplied owner to the owned canvas'
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

reset role;
select * from finish();
rollback;

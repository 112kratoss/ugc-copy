begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

select ok(
  not has_table_privilege('anon', 'public.contact_messages', 'SELECT, INSERT, UPDATE, DELETE'),
  'anonymous callers have no contact-message Data API privileges'
);
select ok(
  not has_table_privilege('authenticated', 'public.contact_messages', 'SELECT, INSERT, UPDATE, DELETE'),
  'authenticated callers have no contact-message Data API privileges'
);
select ok(
  has_table_privilege('service_role', 'public.contact_messages', 'SELECT')
    and has_table_privilege('service_role', 'public.contact_messages', 'INSERT'),
  'the service layer can submit and read contact messages'
);
select ok(
  not has_table_privilege('service_role', 'public.contact_messages', 'UPDATE, DELETE'),
  'contact-message mutation remains behind the audited service RPC'
);

select ok(
  not has_table_privilege('anon', 'public.workflow_canvas_runs', 'SELECT, INSERT, UPDATE, DELETE'),
  'anonymous callers have no workflow-run table privileges'
);
select ok(
  not has_table_privilege('anon', 'public.workflow_canvas_run_steps', 'SELECT, INSERT, UPDATE, DELETE'),
  'anonymous callers have no workflow-step table privileges'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'SELECT')
    and has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'INSERT')
    and has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'UPDATE'),
  'authenticated workflow-run compatibility privileges are explicit'
);
select ok(
  has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'SELECT')
    and has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'INSERT')
    and has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'UPDATE'),
  'authenticated workflow-step compatibility privileges are explicit'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_canvas_runs', 'DELETE')
    and not has_table_privilege('authenticated', 'public.workflow_canvas_run_steps', 'DELETE'),
  'authenticated workflow callers cannot delete run history'
);
select ok(
  has_table_privilege('service_role', 'public.workflow_canvas_runs', 'SELECT')
    and has_table_privilege('service_role', 'public.workflow_canvas_runs', 'INSERT')
    and has_table_privilege('service_role', 'public.workflow_canvas_runs', 'UPDATE')
    and has_table_privilege('service_role', 'public.workflow_canvas_runs', 'DELETE'),
  'the workflow service retains its complete run-table contract'
);
select ok(
  has_table_privilege('service_role', 'public.workflow_canvas_run_steps', 'SELECT')
    and has_table_privilege('service_role', 'public.workflow_canvas_run_steps', 'INSERT')
    and has_table_privilege('service_role', 'public.workflow_canvas_run_steps', 'UPDATE')
    and has_table_privilege('service_role', 'public.workflow_canvas_run_steps', 'DELETE'),
  'the workflow service retains its complete step-table contract'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('d1000000-0000-4000-8000-000000000001'::uuid, 'grant-owner@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('d2000000-0000-4000-8000-000000000002'::uuid, 'grant-attacker@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.workflow_canvases (id, user_id, title, graph)
values
  ('d3000000-0000-4000-8000-000000000003'::uuid,
   'd1000000-0000-4000-8000-000000000001'::uuid,
   'Grant owner canvas', '{"version":1,"nodes":[],"edges":[]}'::jsonb),
  ('d4000000-0000-4000-8000-000000000004'::uuid,
   'd2000000-0000-4000-8000-000000000002'::uuid,
   'Grant attacker canvas', '{"version":1,"nodes":[],"edges":[]}'::jsonb);

insert into public.workflow_canvas_runs (
  id, canvas_id, user_id, start_node_id, mode, status, graph_snapshot
) values (
  'd5000000-0000-4000-8000-000000000005'::uuid,
  'd3000000-0000-4000-8000-000000000003'::uuid,
  'd1000000-0000-4000-8000-000000000001'::uuid,
  'owner-start', 'node', 'processing', '{}'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)
    from public.workflow_canvas_runs
    where id = 'd5000000-0000-4000-8000-000000000005'::uuid
  ),
  0::bigint,
  'the explicit read grant remains owner-scoped by RLS'
);
select throws_ok(
  $$
    insert into public.workflow_canvas_runs (
      canvas_id, user_id, start_node_id, mode, status, graph_snapshot
    ) values (
      'd3000000-0000-4000-8000-000000000003'::uuid,
      'd1000000-0000-4000-8000-000000000001'::uuid,
      'forged-start', 'node', 'processing', '{}'::jsonb
    )
  $$,
  '42501',
  null,
  'the explicit write grant cannot cross the owner RLS boundary'
);
select lives_ok(
  $$
    insert into public.workflow_canvas_runs (
      canvas_id, user_id, start_node_id, mode, status, graph_snapshot
    ) values (
      'd4000000-0000-4000-8000-000000000004'::uuid,
      'd2000000-0000-4000-8000-000000000002'::uuid,
      'own-start', 'node', 'processing', '{}'::jsonb
    )
  $$,
  'the compatibility grant still permits an active owner to create their own run'
);

reset role;
select set_config('request.jwt.claims', '{}', true);

select ok(
  exists (
    select 1
    from pg_policy as policy
    where policy.polrelid = 'public.workflow_canvas_runs'::regclass
      and policy.polname = 'authenticated_identity_active'
      and not policy.polpermissive
      and (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
  ),
  'workflow runs retain the restrictive active-identity boundary'
);
select ok(
  exists (
    select 1
    from pg_policy as policy
    where policy.polrelid = 'public.workflow_canvas_run_steps'::regclass
      and policy.polname = 'authenticated_identity_active'
      and not policy.polpermissive
      and (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
  ),
  'workflow steps retain the restrictive active-identity boundary'
);
select ok(
  not exists (
    select 1
    from pg_policy as policy
    where policy.polrelid = 'public.contact_messages'::regclass
      and policy.polpermissive
      and (
        0 = any(policy.polroles)
        or (select oid from pg_roles where rolname = 'anon') = any(policy.polroles)
        or (select oid from pg_roles where rolname = 'authenticated') = any(policy.polroles)
      )
  ),
  'contact messages expose no public or authenticated permissive policy'
);

select * from finish();
rollback;

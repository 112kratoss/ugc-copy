-- Stalled workflow adoption must exclude runs with live queue ownership before
-- applying its page limit. Otherwise a fixed set of old, healthy runs can hide
-- every later orphan forever.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

select has_index(
  'public',
  'workflow_run_step_jobs',
  'workflow_run_step_jobs_canvas_idx',
  'the denormalised canvas foreign key has a supporting index'
);

select has_index(
  'public',
  'workflow_canvas_runs',
  'workflow_canvas_runs_stalled_idx',
  'the stalled-run sweep has a dedicated partial index'
);

select is(
  (
    select string_agg(attributes.attname, ',' order by keys.ordinality)
    from pg_catalog.pg_index AS indexes
    cross join lateral unnest(indexes.indkey) with ordinality AS keys(attnum, ordinality)
    join pg_catalog.pg_attribute AS attributes
      on attributes.attrelid = indexes.indrelid
     and attributes.attnum = keys.attnum
    where indexes.indexrelid = 'public.workflow_canvas_runs_stalled_idx'::regclass
  ),
  'created_at,id',
  'the stalled-run index supports deterministic oldest-first traversal'
);

select ok(
  position(
    'status = ''processing''::text' in (
      select pg_catalog.pg_get_expr(indexes.indpred, indexes.indrelid)
      from pg_catalog.pg_index AS indexes
      where indexes.indexrelid = 'public.workflow_canvas_runs_stalled_idx'::regclass
    )
  ) > 0,
  'the stalled-run index excludes terminal and approval-waiting history'
);

select is(
  (
    select procedures.prosecdef
    from pg_catalog.pg_proc AS procedures
    where procedures.oid =
      'public.list_stalled_workflow_runs_without_live_jobs(timestamptz,integer)'::regprocedure
  ),
  true,
  'the internal adoption probe runs with its owner privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.list_stalled_workflow_runs_without_live_jobs(timestamptz,integer)',
    'EXECUTE'
  ),
  'the service role can execute the adoption probe'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.list_stalled_workflow_runs_without_live_jobs(timestamptz,integer)',
    'EXECUTE'
  ),
  'anonymous clients cannot execute the internal adoption probe'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_stalled_workflow_runs_without_live_jobs(timestamptz,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot execute the internal adoption probe'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'd1000000-0000-4000-8000-000000000001'::uuid,
  'stalled-workflow-owner@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.workflow_canvases (id, user_id, title, graph)
values (
  'd2000000-0000-4000-8000-000000000001'::uuid,
  'd1000000-0000-4000-8000-000000000001'::uuid,
  'Stalled adoption fixture',
  '{"version":1,"nodes":[],"edges":[]}'::jsonb
);

-- Twenty-five older runs all have live queue owners. Run 26 is later but still
-- older than the cutoff and is the orphan the sweep must be able to see.
insert into public.workflow_canvas_runs (
  id, canvas_id, user_id, start_node_id, mode, status, created_at
)
select
  ('d3000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'd2000000-0000-4000-8000-000000000001'::uuid,
  'd1000000-0000-4000-8000-000000000001'::uuid,
  'start',
  'branch',
  'processing',
  '2000-01-01 00:00:00+00'::timestamptz + series * interval '1 minute'
from generate_series(1, 26) AS series;

insert into public.workflow_run_step_jobs (
  id, run_id, canvas_id, node_id, attempt, status, next_attempt_at,
  locked_at, locked_by, heartbeat_at, created_at, updated_at
)
select
  ('d4000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  ('d3000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'd2000000-0000-4000-8000-000000000001'::uuid,
  'start',
  1,
  case when series % 2 = 0 then 'processing' else 'pending' end,
  '2000-01-01 01:00:00+00'::timestamptz,
  case when series % 2 = 0 then '2000-01-01 00:30:00+00'::timestamptz else null end,
  case when series % 2 = 0 then 'fixture-worker' else null end,
  case when series % 2 = 0 then '2000-01-01 00:31:00+00'::timestamptz else null end,
  '2000-01-01 00:00:00+00'::timestamptz + series * interval '1 minute',
  '2000-01-01 00:00:00+00'::timestamptz + series * interval '1 minute'
from generate_series(1, 25) AS series;

select is(
  (
    select count(*)
    from public.list_stalled_workflow_runs_without_live_jobs(
      '2000-01-02 00:00:00+00'::timestamptz,
      1
    )
  ),
  1::bigint,
  'the bounded probe finds one orphan beyond 25 older live runs'
);

select is(
  (
    select id
    from public.list_stalled_workflow_runs_without_live_jobs(
      '2000-01-02 00:00:00+00'::timestamptz,
      1
    )
  ),
  'd3000000-0000-4000-8000-000000000026'::uuid,
  'LIMIT is applied after the live-job anti-join, so the later orphan is selected'
);

select is(
  (
    select count(*)
    from public.list_stalled_workflow_runs_without_live_jobs(
      '2000-01-02 00:00:00+00'::timestamptz,
      100
    ) AS stalled
    join public.workflow_run_step_jobs AS jobs on jobs.run_id = stalled.id
    where jobs.status in ('pending', 'processing')
  ),
  0::bigint,
  'the probe never returns a run with a pending or processing ticket'
);

select * from finish();
rollback;

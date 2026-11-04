-- backend_rate_limits_window_start_idx (20261104135153): the retention prune
-- and the cost report's aggregate both lead with window_start, and both can
-- now be answered from the index instead of a scan of the whole table.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

create function pg_temp.plan_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_line record;
  v_plan text := '';
begin
  for v_line in execute 'explain (costs off) ' || p_sql loop
    v_plan := v_plan || v_line."QUERY PLAN" || E'\n';
  end loop;
  return v_plan;
end;
$$;

select is(
  (select pg_catalog.pg_get_indexdef(index_class.oid)
   from pg_catalog.pg_class as index_class
   where index_class.relname = 'backend_rate_limits_window_start_idx'
     and index_class.relnamespace = 'public'::regnamespace),
  'CREATE INDEX backend_rate_limits_window_start_idx ON public.backend_rate_limits USING btree (window_start, scope, subject_key)',
  'the window index leads with window_start, in the prune''s order'
);

-- Enough rows over enough windows that the planner has a choice to make: half
-- an hour apart over six weeks, so a day is a small slice of the table.
insert into public.backend_rate_limits (scope, subject_key, window_start, request_count)
select 'test:window-index:' || (n % 7), 'subject-' || n, now() - make_interval(mins => n * 30), 1
from generate_series(1, 2000) as n;
analyze public.backend_rate_limits;

-- Asked to avoid a scan of the whole table, the planner can answer both
-- predicates from the index. (Whether it should is a cost decision it makes
-- against the table's real size; this pins that the index is usable.)
set local enable_seqscan = off;

select ok(
  pg_temp.plan_of($q$
    select scope, subject_key, window_start
    from public.backend_rate_limits
    where window_start < now() - interval '1 day'
    order by window_start, scope, subject_key
    limit 50
    for update skip locked
  $q$) like '%Index Scan using backend_rate_limits_window_start_idx%',
  'the retention prune''s batch is an index scan in window order'
);

select ok(
  pg_temp.plan_of($q$
    select scope, subject_key, window_start
    from public.backend_rate_limits
    where window_start < now() - interval '1 day'
    order by window_start, scope, subject_key
    limit 50
  $q$) not like '%Sort%',
  'the batch needs no sort: the index is already in its order'
);

select ok(
  pg_temp.plan_of($q$
    select coalesce(rows.scope, 'unknown'), rows.request_count
    from public.backend_rate_limits as rows
    where rows.window_start >= now() - interval '24 hours'
  $q$) like '%backend_rate_limits_window_start_idx%',
  'the cost report''s 24-hour window reads through the index'
);

select ok(
  pg_temp.plan_of($q$
    select 1 from public.backend_rate_limits
    where scope = 'test:window-index:1' and subject_key = 'subject-1'
      and window_start < now() - interval '1 day'
  $q$) like '%backend_rate_limits_pkey%',
  'the per-request cleanup keeps its primary-key lookup'
);

reset enable_seqscan;

-- The real readers still answer correctly through it.
select lives_ok(
  $$ select public.get_backend_cost_aggregates(now() - interval '24 hours', array[]::text[]) $$,
  'the cost aggregate still runs'
);

select * from finish();
rollback;

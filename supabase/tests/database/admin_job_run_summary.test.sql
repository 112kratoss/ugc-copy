begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(11);

select ok(to_regprocedure('public.admin_job_run_summary(timestamptz)') is not null, 'summary RPC exists');
select ok(not has_function_privilege('anon', 'public.admin_job_run_summary(timestamptz)', 'EXECUTE'), 'anonymous cannot read job summary');
select ok(not has_function_privilege('authenticated', 'public.admin_job_run_summary(timestamptz)', 'EXECUTE'), 'authenticated cannot read job summary');
select ok(has_function_privilege('service_role', 'public.admin_job_run_summary(timestamptz)', 'EXECUTE'), 'service role can read job summary');
select is((select provolatile::text from pg_proc where oid='public.admin_job_run_summary(timestamptz)'::regprocedure), 's', 'one stable database snapshot');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.admin_job_run_summary(timestamptz)'::regprocedure), 'definer search path is fixed');

set local role anon;
select throws_ok($$select * from public.admin_job_run_summary(now()-interval '1 day')$$, '42501', null, 'anonymous RPC execution is denied');
reset role;
set local role authenticated;
select throws_ok($$select * from public.admin_job_run_summary(now()-interval '1 day')$$, '42501', null, 'authenticated RPC execution is denied');
reset role;

insert into public.backend_job_runs(id,job_name,route,request_id,lock_owner,status,started_at) values
('a0110000-0000-4000-8000-000000000001','audit-summary-test','/audit/local','one','audit','succeeded',now()-interval '2 seconds'),
('a0110000-0000-4000-8000-000000000002','audit-summary-test','/audit/local','two','audit','failed',now()-interval '2 seconds'),
('a0110000-0000-4000-8000-000000000003','audit-summary-test','/audit/local','old','audit','failed',now()-interval '2 days');

set local role service_role;
select results_eq($$select run_count, failure_count from public.admin_job_run_summary(now()-interval '1 day') where job_name='audit-summary-test'$$,
  $$values (2::bigint,1::bigint)$$, 'daily counts exclude older runs');
select is((select last_status from public.admin_job_run_summary(now()-interval '1 day') where job_name='audit-summary-test'), 'failed', 'equal timestamps use the id tie breaker');
select is((select count(*) from public.admin_job_run_summary(now()) where job_name='audit-summary-test'), 0::bigint, 'empty window has no summary row');
reset role;
select * from finish();
rollback;

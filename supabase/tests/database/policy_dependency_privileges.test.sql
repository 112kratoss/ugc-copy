-- A policy's sub-selects and function calls run with the privileges of the role
-- querying its table, so a policy a client role is subject to may read only
-- what that role may read itself. Otherwise every query the role makes on that
-- table fails with 42501, on its own rows too: revoking the generations grant
-- (20261031033532) would have done that to workflow_canvas_run_steps had its
-- policy kept sub-selecting generations. A policy on a table the role holds no
-- privilege on never runs, and is skipped.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(4);

create function pg_temp.policy_dependencies_out_of_reach(p_role name, p_kind text)
returns text
language sql
stable
as $$
  select string_agg(dependency, '; ' order by dependency)
  from (
    select format('%s.%s %I -> %s', n.nspname, c.relname, p.polname,
      case when d.refclassid = 'pg_proc'::regclass then d.refobjid::regprocedure::text
           else d.refobjid::regclass::text || coalesce('.' || a.attname, '') end) as dependency
    from pg_policy as p
    join pg_class as c on c.oid = p.polrelid
    join pg_namespace as n on n.oid = c.relnamespace
    join pg_depend as d on d.classid = 'pg_policy'::regclass and d.objid = p.oid
    left join pg_attribute as a
      on d.refclassid = 'pg_class'::regclass and a.attrelid = d.refobjid
     and a.attnum = d.refobjsubid and d.refobjsubid > 0
    where (0 = any(p.polroles) or (select oid from pg_roles where rolname = p_role) = any(p.polroles))
      and (has_any_column_privilege(p_role, p.polrelid, 'SELECT, INSERT, UPDATE')
           or has_table_privilege(p_role, p.polrelid, 'DELETE'))
      and case p_kind
        when 'relation' then d.refclassid = 'pg_class'::regclass
          and d.refobjid <> p.polrelid
          and not case when d.refobjsubid = 0
            then has_any_column_privilege(p_role, d.refobjid, 'SELECT')
            else has_column_privilege(p_role, d.refobjid, d.refobjsubid::smallint, 'SELECT') end
        when 'function' then d.refclassid = 'pg_proc'::regclass
          and not has_function_privilege(p_role, d.refobjid, 'EXECUTE')
      end
  ) as dependencies
$$;

select is(pg_temp.policy_dependencies_out_of_reach('authenticated', 'relation'), null::text,
  'policies authenticated is subject to read only relations and columns it may read');
select is(pg_temp.policy_dependencies_out_of_reach('authenticated', 'function'), null::text,
  'policies authenticated is subject to call only functions it may execute');
select is(pg_temp.policy_dependencies_out_of_reach('anon', 'relation'), null::text,
  'policies anon is subject to read only relations and columns it may read');
select is(pg_temp.policy_dependencies_out_of_reach('anon', 'function'), null::text,
  'policies anon is subject to call only functions it may execute');

select * from finish();
rollback;

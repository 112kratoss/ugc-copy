-- Schema fingerprint — one digest per object class.
--
-- The Supabase CLI cannot reach this project's production database from a
-- developer machine (neither the direct nor the pooler endpoint), so
-- `db push --dry-run --linked` and `supabase migration list` cannot answer
-- "does the repository still describe production?". This query can: run it on
-- both sides and compare the digests.
--
-- Production:  Supabase MCP `execute_sql`, or the Management API query endpoint.
-- Local/CI:    psql against a database built by `supabase db reset --local`.
--
-- Every class is deliberately owner-agnostic and value-agnostic: ownership,
-- sequence positions, row data and OIDs differ between a fresh replay and a
-- long-lived production database without meaning anything. What is left is the
-- schema a migration history is supposed to reproduce.
--
-- `column_order` is split out from `columns` on purpose. Column order changes
-- what `select *` returns but nothing about the declared schema, so it should
-- be visible without being able to fail the parity check on its own.

with
tables as (
  select 'tables' as class,
         c.relname
           || '|rls=' || c.relrowsecurity::text
           || '|force=' || c.relforcerowsecurity::text
           || '|persist=' || c.relpersistence::text as sig
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
),
columns as (
  select 'columns' as class,
         c.relname || '.' || a.attname
           || '|' || format_type(a.atttypid, a.atttypmod)
           || '|notnull=' || a.attnotnull::text
           || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
           || '|identity=' || a.attidentity::text
           || '|generated=' || a.attgenerated::text as sig
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and a.attnum > 0
    and not a.attisdropped
),
column_order as (
  select 'column_order' as class,
         c.relname || '.' || a.attname || '|ord=' || a.attnum::text as sig
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and a.attnum > 0
    and not a.attisdropped
),
constraints as (
  select 'constraints' as class,
         c.relname || '|' || con.conname || '|' || pg_get_constraintdef(con.oid) as sig
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
indexes as (
  select 'indexes' as class,
         indexname || '|' || indexdef as sig
  from pg_indexes
  where schemaname = 'public'
),
functions as (
  select 'functions' as class,
         p.oid::regprocedure::text
           || '|kind=' || p.prokind::text
           || '|returns=' || pg_get_function_result(p.oid)
           || '|secdef=' || p.prosecdef::text
           || '|volatile=' || p.provolatile::text
           || '|strict=' || p.proisstrict::text
           || '|config=' || coalesce(array_to_string(p.proconfig, ','), '')
           || '|body=' || md5(coalesce(p.prosrc, '')) as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
triggers as (
  select 'triggers' as class,
         c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid) as sig
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and not t.tgisinternal
),
policies as (
  select 'policies' as class,
         c.relname || '|' || pol.polname
           || '|cmd=' || pol.polcmd::text
           || '|permissive=' || pol.polpermissive::text
           || '|roles=' || coalesce((
                select string_agg(
                  case when r = 0 then 'PUBLIC' else r::regrole::text end, ',' order by r
                )
                from unnest(pol.polroles) as r
              ), '')
           || '|using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
           || '|check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as sig
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
views as (
  select 'views' as class,
         c.relname || '|kind=' || c.relkind::text
           || '|def=' || md5(pg_get_viewdef(c.oid, true)) as sig
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
),
enums as (
  select 'enums' as class,
         t.typname || '|' || coalesce((
           select string_agg(e.enumlabel, ',' order by e.enumsortorder)
           from pg_enum e
           where e.enumtypid = t.oid
         ), '') as sig
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
    and t.typtype = 'e'
),
sequences as (
  select 'sequences' as class,
         c.relname
           || '|' || format_type(s.seqtypid, null)
           || '|inc=' || s.seqincrement::text
           || '|min=' || s.seqmin::text
           || '|max=' || s.seqmax::text
           || '|cycle=' || s.seqcycle::text as sig
  from pg_sequence s
  join pg_class c on c.oid = s.seqrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
grants_table as (
  -- Effective privilege, not acl rows. A null acl means "defaults apply",
  -- which for a table is owner-only and for a function is EXECUTE to PUBLIC —
  -- so counting materialised acl entries reports a difference where the two
  -- databases actually agree. These are the three roles the application
  -- reaches Postgres as; the owner is deliberately not among them.
  select 'grants_table' as class,
         c.relname || '|' || r.rolname || '|' || pr.priv as sig
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                     ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as pr(priv)
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'v', 'm')
    and has_table_privilege(r.rolname, c.oid, pr.priv)
),
grants_sequence as (
  select 'grants_sequence' as class,
         c.relname || '|' || r.rolname || '|' || pr.priv as sig
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
  cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as pr(priv)
  where n.nspname = 'public'
    and c.relkind = 'S'
    and has_sequence_privilege(r.rolname, c.oid, pr.priv)
),
grants_routine as (
  select 'grants_routine' as class,
         p.oid::regprocedure::text || '|' || r.rolname as sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
  where n.nspname = 'public'
    and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
),
extensions as (
  select 'extensions' as class,
         e.extname || '|' || n.nspname as sig
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
),
storage_policies as (
  select 'storage_policies' as class,
         c.relname || '|' || pol.polname
           || '|cmd=' || pol.polcmd::text
           || '|roles=' || coalesce((
                select string_agg(
                  case when r = 0 then 'PUBLIC' else r::regrole::text end, ',' order by r
                )
                from unnest(pol.polroles) as r
              ), '')
           || '|using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
           || '|check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as sig
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage'
),
storage_buckets as (
  select 'storage_buckets' as class,
         id || '|public=' || public::text
           || '|limit=' || coalesce(file_size_limit::text, '')
           || '|mime=' || coalesce(array_to_string(allowed_mime_types, ','), '') as sig
  from storage.buckets
),
all_sigs as (
  select * from tables
  union all select * from columns
  union all select * from column_order
  union all select * from constraints
  union all select * from indexes
  union all select * from functions
  union all select * from triggers
  union all select * from policies
  union all select * from views
  union all select * from enums
  union all select * from sequences
  union all select * from grants_table
  union all select * from grants_sequence
  union all select * from grants_routine
  union all select * from extensions
  union all select * from storage_policies
  union all select * from storage_buckets
)
select class,
       count(*)::int as objects,
       md5(string_agg(sig, E'\n' order by sig)) as digest
from all_sigs
group by class
order by class;

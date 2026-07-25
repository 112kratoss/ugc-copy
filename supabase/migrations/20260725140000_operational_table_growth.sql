-- Operational table growth reporting for the protected ops dashboard.
--
-- Table sizes live in `pg_stat_user_tables` and `pg_total_relation_size`, which
-- PostgREST cannot expose directly. This wraps them in a narrow, service-role
-- only function that returns row counts and byte sizes for the operational
-- tables the retention sweep manages, so growth is visible before it becomes a
-- cost or latency problem.
--
-- Deliberately narrow: it reports only the churn-prone operational tables, not
-- every table in the schema, so it can never become a general schema-disclosure
-- surface.

CREATE OR REPLACE FUNCTION public.get_operational_table_growth()
RETURNS TABLE (
  table_name text,
  live_rows bigint,
  total_bytes bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $function$
  SELECT
    stats.relname::text AS table_name,
    stats.n_live_tup AS live_rows,
    pg_catalog.pg_total_relation_size(stats.relid) AS total_bytes
  FROM pg_catalog.pg_stat_user_tables AS stats
  WHERE stats.schemaname = 'public'
    AND stats.relname = ANY (ARRAY[
      'backend_job_runs',
      'backend_rate_limits',
      'generation_completion_jobs',
      'provider_dependency_events',
      'generation_model_provider_checks',
      'feed_events',
      'feed_session_items',
      'feed_sessions'
    ])
  ORDER BY pg_catalog.pg_total_relation_size(stats.relid) DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM anon;
REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth() TO service_role;

COMMENT ON FUNCTION public.get_operational_table_growth()
  IS 'Row counts and byte sizes for the churn-prone operational tables managed by prune_operational_backend_data. Service role only.';

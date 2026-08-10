-- Certification remediation: queue/retention monitoring must not become a
-- second full-table workload as telemetry grows. Preserve the public function
-- shape, but use PostgreSQL's planner estimate for informational row counts.
-- Oldest-row timestamps remain exact index reads and are the actual SLO input.

CREATE OR REPLACE FUNCTION public.get_feed_retention_lag()
RETURNS TABLE (
  table_name text,
  oldest_row_at timestamptz,
  row_count bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT 'feed_delivery_facts'::text,
         (SELECT ranked_at FROM public.feed_delivery_facts ORDER BY ranked_at ASC LIMIT 1),
         (SELECT greatest(reltuples, 0)::bigint
            FROM pg_class WHERE oid = 'public.feed_delivery_facts'::regclass)
  UNION ALL
  SELECT 'feed_events'::text,
         (SELECT occurred_at FROM public.feed_events ORDER BY occurred_at ASC LIMIT 1),
         (SELECT greatest(reltuples, 0)::bigint
            FROM pg_class WHERE oid = 'public.feed_events'::regclass);
$function$;

COMMENT ON FUNCTION public.get_feed_retention_lag() IS
  'Exact oldest retained row plus constant-cost planner row estimate for feed telemetry tables.';

REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM anon;
REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_feed_retention_lag() TO service_role;

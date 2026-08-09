-- F7b: make the fact tables visible to monitoring, and measure retention lag.
--
-- `feed_delivery_facts` is the table the whole 5,000 MAU gate is derived from,
-- and it was the one table missing from `get_operational_table_growth` -- which
-- already covered `feed_events`, `feed_sessions` and `feed_session_items`.
-- Measured in production today it is **14 MB across 14,983 rows**, roughly 1 KB
-- per row (the `score_components` jsonb dominates), which is the figure behind
-- this item's GiB projections and is now confirmed rather than assumed.
--
-- Retention lag is the second half, and it is a different question from growth.
-- A table can sit at a healthy size while the sweep silently stops keeping up,
-- because the prune is capped per run: FEED_RETENTION_PRUNE_LIMIT is 5,000 an
-- hour, so once inserts exceed that the oldest row ages past the retention
-- window and nothing in the current reporting says so. Row counts would look
-- merely "large", not "unpruned".

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
      'feed_delivery_facts',
      'feed_events',
      'feed_session_items',
      'feed_sessions',
      'workflow_run_step_jobs'
    ])
  ORDER BY pg_catalog.pg_total_relation_size(stats.relid) DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM anon;
REVOKE ALL ON FUNCTION public.get_operational_table_growth() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth() TO service_role;

-- ─── Retention lag ───────────────────────────────────────────────────────────

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
  -- One cheap min() per table. Both columns are indexed for the prune, so this
  -- is an index scan rather than the sequential count the naive form would do.
  SELECT 'feed_delivery_facts'::text,
         (SELECT min(ranked_at) FROM public.feed_delivery_facts),
         (SELECT count(*) FROM public.feed_delivery_facts)
  UNION ALL
  SELECT 'feed_events'::text,
         (SELECT min(occurred_at) FROM public.feed_events),
         (SELECT count(*) FROM public.feed_events);
$function$;

COMMENT ON FUNCTION public.get_feed_retention_lag() IS
  'Oldest retained row per feed telemetry table (F7b). Compared against the configured retention window in feed-retention-lag.ts to detect a prune that has stopped keeping up.';

REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM anon;
REVOKE ALL ON FUNCTION public.get_feed_retention_lag() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_feed_retention_lag() TO service_role;

-- get_operational_table_growth (20260822121000) watched the churn-prone
-- operational tables but not the ones the 2026-11-04 usage audit found
-- growing unwatched: guests, feed_viewer_daily, ai_usage_events, the
-- notification tables, playback_metrics and backend_job_locks. Reproduced with
-- those added, plus onboarding_events and the playback rollup, which now have
-- retention of their own (20261104135403), and two rows for guests:
--
-- * auth.users, read like every other table (live rows and bytes from the
--   statistics views), so the growth of identities as a whole is visible;
-- * guest_identities, the exact number of anonymous users not deleted,
--   counted through users_is_anonymous_idx. Its bytes are reported as 0: they
--   are part of auth.users' and would otherwise be counted twice in the total.
--
-- The returned columns are unchanged, so the caller (operational-table-
-- growth.ts) reads the new rows as it reads the old ones.

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
  SELECT growth.table_name, growth.live_rows, growth.total_bytes
  FROM (
    SELECT
      stats.relname::text AS table_name,
      stats.n_live_tup AS live_rows,
      pg_catalog.pg_total_relation_size(stats.relid) AS total_bytes
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'public'
      AND stats.relname = ANY (ARRAY[
        'account_merge_tickets',
        'ai_usage_events',
        'backend_job_locks',
        'backend_job_runs',
        'backend_rate_limits',
        'feed_delivery_facts',
        'feed_events',
        'feed_session_items',
        'feed_sessions',
        'feed_viewer_daily',
        'generation_completion_jobs',
        'generation_model_provider_checks',
        'mobile_notifications',
        'mobile_push_deliveries',
        'onboarding_events',
        'playback_metrics',
        'playback_metrics_daily_rollup',
        'provider_dependency_events',
        'template_run_steps',
        'template_runs',
        'upload_byte_reservations',
        'upload_byte_user_counters',
        'upload_path_tombstones',
        'workflow_canvas_run_steps',
        'workflow_canvas_runs',
        'workflow_run_step_jobs'
      ])

    UNION ALL

    SELECT
      'auth.users',
      stats.n_live_tup,
      pg_catalog.pg_total_relation_size(stats.relid)
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'auth'
      AND stats.relname = 'users'

    UNION ALL

    SELECT
      'guest_identities',
      (
        SELECT count(*)
        FROM auth.users AS guest
        WHERE guest.is_anonymous
          AND guest.deleted_at IS NULL
      ),
      0::bigint
  ) AS growth
  ORDER BY growth.total_bytes DESC, growth.table_name;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()
  TO service_role;

COMMENT ON FUNCTION public.get_operational_table_growth() IS
  'Row counts and byte sizes for churn-prone operational state, append-only telemetry with retention, permanent security ledgers, user-owned workflow history, auth.users and the exact count of live guest identities (bytes 0: part of auth.users). Service role only.';

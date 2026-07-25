-- Bounded retention for high-churn operational tables.
--
-- These tables are backend telemetry and audit trails, not product data. They
-- grow with scheduler cadence rather than with usage: at the time this was
-- written `backend_job_runs` held 15,660 rows (10 MB) growing ~461 rows/day,
-- while the entire `generations` table held 79 rows.
--
-- Deliberately NOT covered here: `post_share_events`, `feed_events`, and any
-- other table carrying product or creator analytics. Feed personalization has
-- its own retention path in `prune_feed_personalization_data`.
--
-- Every delete is bounded by an explicit row cap so a single invocation cannot
-- hold long locks or blow the statement timeout. The caller re-invokes on the
-- next scheduled run until the backlog drains.

CREATE OR REPLACE FUNCTION public.prune_operational_backend_data(
  p_now timestamptz DEFAULT now(),
  p_job_run_retention_days integer DEFAULT 30,
  p_skipped_job_run_retention_days integer DEFAULT 7,
  p_rate_limit_retention_days integer DEFAULT 2,
  p_completion_job_retention_days integer DEFAULT 14,
  p_provider_event_retention_days integer DEFAULT 30,
  p_provider_check_retention_days integer DEFAULT 60,
  p_max_deletes_per_table integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job_runs_deleted integer := 0;
  v_rate_limits_deleted integer := 0;
  v_completion_jobs_deleted integer := 0;
  v_provider_events_deleted integer := 0;
  v_provider_checks_deleted integer := 0;
  v_now timestamptz := coalesce(p_now, now());
  v_max_deletes integer := greatest(1, coalesce(p_max_deletes_per_table, 5000));
BEGIN
  IF p_job_run_retention_days < 1
     OR p_skipped_job_run_retention_days < 1
     OR p_rate_limit_retention_days < 1
     OR p_completion_job_retention_days < 1
     OR p_provider_event_retention_days < 1
     OR p_provider_check_retention_days < 1 THEN
    RAISE EXCEPTION 'operational retention windows must be at least one day';
  END IF;

  -- Finished job-run audit rows. `started` rows and anything without a
  -- finished_at are never pruned, so an in-flight or stuck run stays visible to
  -- the health checks regardless of age.
  --
  -- `skipped` rows dominate this table (97% of it when this was written: the
  -- scheduler wakes every 10 minutes and usually finds no work) and carry
  -- almost no forensic value, so they get a much shorter window than the
  -- succeeded/failed rows an incident actually needs.
  WITH prunable AS (
    SELECT id
    FROM public.backend_job_runs
    WHERE finished_at IS NOT NULL
      AND status <> 'started'
      AND (
        (status = 'skipped' AND started_at < v_now - make_interval(days => p_skipped_job_run_retention_days))
        OR (status IN ('succeeded', 'failed') AND started_at < v_now - make_interval(days => p_job_run_retention_days))
      )
    ORDER BY started_at
    LIMIT v_max_deletes
  )
  DELETE FROM public.backend_job_runs AS runs
  USING prunable
  WHERE runs.id = prunable.id;
  GET DIAGNOSTICS v_job_runs_deleted = ROW_COUNT;

  -- Rate-limit counters are windowed; once the window is well past, the row can
  -- never affect a decision again.
  WITH prunable AS (
    SELECT scope, subject_key, window_start
    FROM public.backend_rate_limits
    WHERE window_start < v_now - make_interval(days => p_rate_limit_retention_days)
    ORDER BY window_start
    LIMIT v_max_deletes
  )
  DELETE FROM public.backend_rate_limits AS limits
  USING prunable
  WHERE limits.scope = prunable.scope
    AND limits.subject_key = prunable.subject_key
    AND limits.window_start = prunable.window_start;
  GET DIAGNOSTICS v_rate_limits_deleted = ROW_COUNT;

  -- Only terminal completion jobs are prunable. A pending or retrying job is
  -- still owed work and must survive regardless of age.
  WITH prunable AS (
    SELECT id
    FROM public.generation_completion_jobs
    WHERE status IN ('succeeded', 'failed')
      AND coalesce(completed_at, updated_at, created_at)
          < v_now - make_interval(days => p_completion_job_retention_days)
    ORDER BY coalesce(completed_at, updated_at, created_at)
    LIMIT v_max_deletes
  )
  DELETE FROM public.generation_completion_jobs AS jobs
  USING prunable
  WHERE jobs.id = prunable.id;
  GET DIAGNOSTICS v_completion_jobs_deleted = ROW_COUNT;

  -- Provider dependency telemetry feeds latency/failure summaries over a recent
  -- window only.
  WITH prunable AS (
    SELECT id
    FROM public.provider_dependency_events
    WHERE created_at < v_now - make_interval(days => p_provider_event_retention_days)
    ORDER BY created_at
    LIMIT v_max_deletes
  )
  DELETE FROM public.provider_dependency_events AS events
  USING prunable
  WHERE events.id = prunable.id;
  GET DIAGNOSTICS v_provider_events_deleted = ROW_COUNT;

  -- Catalog provider checks keep their audit value, but only the most recent
  -- check per model is load-bearing. Retain the latest row per model forever and
  -- prune older history past the window.
  WITH latest_per_model AS (
    SELECT DISTINCT ON (model_id) id
    FROM public.generation_model_provider_checks
    ORDER BY model_id, checked_at DESC
  ),
  prunable AS (
    SELECT checks.id
    FROM public.generation_model_provider_checks AS checks
    WHERE checks.checked_at < v_now - make_interval(days => p_provider_check_retention_days)
      AND checks.id NOT IN (SELECT id FROM latest_per_model)
    ORDER BY checks.checked_at
    LIMIT v_max_deletes
  )
  DELETE FROM public.generation_model_provider_checks AS checks
  USING prunable
  WHERE checks.id = prunable.id;
  GET DIAGNOSTICS v_provider_checks_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'job_runs_deleted', v_job_runs_deleted,
    'rate_limits_deleted', v_rate_limits_deleted,
    'completion_jobs_deleted', v_completion_jobs_deleted,
    'provider_events_deleted', v_provider_events_deleted,
    'provider_checks_deleted', v_provider_checks_deleted,
    'total_deleted', v_job_runs_deleted
      + v_rate_limits_deleted
      + v_completion_jobs_deleted
      + v_provider_events_deleted
      + v_provider_checks_deleted,
    'batch_limit_reached', (
      v_job_runs_deleted >= v_max_deletes
      OR v_rate_limits_deleted >= v_max_deletes
      OR v_completion_jobs_deleted >= v_max_deletes
      OR v_provider_events_deleted >= v_max_deletes
      OR v_provider_checks_deleted >= v_max_deletes
    ),
    'pruned_at', v_now
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
) FROM anon;
REVOKE ALL ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
) IS 'Bounded retention sweep for operational backend telemetry and audit tables. Never touches product, creator, or feed analytics data.';

-- Supports the ordered, filtered scans the sweep performs.
CREATE INDEX IF NOT EXISTS backend_job_runs_started_at_idx
  ON public.backend_job_runs (started_at)
  WHERE finished_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_dependency_events_created_at_idx
  ON public.provider_dependency_events (created_at);

CREATE INDEX IF NOT EXISTS generation_model_provider_checks_checked_at_idx
  ON public.generation_model_provider_checks (checked_at);

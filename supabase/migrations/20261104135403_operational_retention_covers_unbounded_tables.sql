-- Operational retention for the tables that had none (usage audit,
-- 2026-11-04). The daily operational-data-retention job already calls
-- prune_operational_backend_data; this widens that one function rather than
-- adding a job:
--
-- * playback_metrics: raw rows are kept 90 days. playback_metrics_daily was a
--   view over the raw rows, not a rollup: pruning them would have erased its
--   history. Each finished UTC day is now rolled up into
--   playback_metrics_daily_rollup before any of its raw rows can go, and the
--   view reads the rollup for those days and the raw rows for the rest, with
--   the same columns.
-- * onboarding_events: kept 365 days (by created_at, the server's clock).
-- * ai_usage_events: after 90 days a settled event (succeeded, failed or
--   refunded) loses its input_prompt, output_text and response_payload. Every
--   accounting column (cost, status, refunded, settled_at, promotional credits,
--   feature, model, the idempotency key hash) stays. Nothing reads the three
--   after settlement except an idempotent replay of the same request, which
--   start_ai_usage_event answers from response_payload; ninety days on, that
--   replay meets 409 AI_USAGE_REPLAY_UNAVAILABLE and is never charged again.
--   A pending event keeps its payload.
-- * mobile_notifications: an unread alert is deleted 365 days after it last
--   changed. Read alerts already go after 180 days
--   (prune_mobile_notification_retention, the push-receipts job).
-- * backend_job_locks: a lock row is deleted a day after it expired. Generation
--   status polling takes a throttle lock per prediction and never releases it;
--   an expired lock and a missing one mean the same thing to
--   try_acquire_backend_job_lock, which inserts or takes over either.
--
-- Every window is a parameter default, as the existing ones are, so the owner
-- changes one by a migration that changes its default. The job passes none of
-- them. Each phase is a bounded batch that skips rows a live writer holds, like
-- the phases before it; the job calls the function again while a batch comes
-- back full (src/lib/operational-data-retention.ts), so the cap bounds a
-- transaction, not a day.
--
-- The signature gains five trailing parameters with defaults, so the old
-- eight-parameter function is dropped first: keeping both would make every
-- named call ambiguous to PostgREST. A deployment still running the old code
-- calls it with p_now and p_max_deletes_per_table only, which the new function
-- accepts.

-- ─── Playback: the daily rollup ─────────────────────────────────────────────

CREATE TABLE public.playback_metrics_daily_rollup (
  -- The UTC day, as date_trunc('day', received_at, 'UTC').
  day timestamptz NOT NULL,
  platform text NOT NULL,
  network text NOT NULL,
  surface text NOT NULL,
  start_kind text NOT NULL,
  sessions bigint NOT NULL CHECK (sessions >= 0),
  starts bigint NOT NULL CHECK (starts >= 0),
  start_total_ms numeric NOT NULL CHECK (start_total_ms >= 0),
  start_max_ms integer NOT NULL CHECK (start_max_ms >= 0),
  start_p50_ms double precision,
  start_p95_ms double precision,
  stalls bigint NOT NULL CHECK (stalls >= 0),
  stall_total_ms numeric NOT NULL CHECK (stall_total_ms >= 0),
  stall_max_ms integer NOT NULL CHECK (stall_max_ms >= 0),
  rolled_up_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (day, platform, network, surface, start_kind)
);

ALTER TABLE public.playback_metrics_daily_rollup ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.playback_metrics_daily_rollup
  FROM PUBLIC, anon, authenticated, service_role;
-- Written only by prune_operational_backend_data, which runs as its owner.
GRANT SELECT ON TABLE public.playback_metrics_daily_rollup TO service_role;

COMMENT ON TABLE public.playback_metrics_daily_rollup IS
  'Finished UTC days of playback_metrics, aggregated as playback_metrics_daily shows them, written by prune_operational_backend_data before a day''s raw rows may be pruned. Kept indefinitely: at most 40 rows a day.';

-- The same columns, types and order as before. A day in the rollup is read from
-- it; any other day (today, and a finished day the job has not reached yet) is
-- aggregated from the raw rows exactly as the view always did. Days are UTC
-- days whatever the reader's time zone, so the two halves always agree on
-- where a day starts.
CREATE OR REPLACE VIEW public.playback_metrics_daily
WITH (security_invoker = true)
AS
WITH rolled_up_days AS (
  SELECT DISTINCT rollup.day
  FROM public.playback_metrics_daily_rollup AS rollup
),
live AS (
  SELECT m.*, date_trunc('day', m.received_at, 'UTC') AS day
  FROM public.playback_metrics AS m
  WHERE NOT EXISTS (
    SELECT 1 FROM rolled_up_days
    WHERE rolled_up_days.day = date_trunc('day', m.received_at, 'UTC')
  )
),
samples AS (
  SELECT day, platform, network, surface, start_kind, unnest(start_samples) AS start_ms
  FROM live
),
percentiles AS (
  SELECT
    day, platform, network, surface, start_kind,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY start_ms) AS start_p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY start_ms) AS start_p95_ms
  FROM samples
  GROUP BY day, platform, network, surface, start_kind
)
SELECT
  rollup.day,
  rollup.platform,
  rollup.network,
  rollup.surface,
  rollup.start_kind,
  rollup.sessions,
  rollup.starts,
  round(rollup.start_total_ms / nullif(rollup.starts, 0), 1) AS start_mean_ms,
  rollup.start_max_ms,
  rollup.start_p50_ms,
  rollup.start_p95_ms,
  rollup.stalls,
  round(rollup.stalls::numeric / nullif(rollup.starts, 0), 4) AS stalls_per_start,
  rollup.stall_total_ms,
  rollup.stall_max_ms
FROM public.playback_metrics_daily_rollup AS rollup
UNION ALL
SELECT
  m.day,
  m.platform,
  m.network,
  m.surface,
  m.start_kind,
  count(DISTINCT m.session_id) AS sessions,
  sum(m.starts) AS starts,
  round(sum(m.start_total_ms)::numeric / nullif(sum(m.starts), 0), 1) AS start_mean_ms,
  max(m.start_max_ms) AS start_max_ms,
  p.start_p50_ms,
  p.start_p95_ms,
  sum(m.stalls) AS stalls,
  round(sum(m.stalls)::numeric / nullif(sum(m.starts), 0), 4) AS stalls_per_start,
  sum(m.stall_total_ms) AS stall_total_ms,
  max(m.stall_max_ms) AS stall_max_ms
FROM live AS m
LEFT JOIN percentiles AS p
  ON p.day = m.day
 AND p.platform = m.platform
 AND p.network = m.network
 AND p.surface = m.surface
 AND p.start_kind = m.start_kind
GROUP BY m.day, m.platform, m.network, m.surface, m.start_kind, p.start_p50_ms, p.start_p95_ms;

REVOKE ALL ON public.playback_metrics_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.playback_metrics_daily TO service_role;

COMMENT ON VIEW public.playback_metrics_daily IS
  'Daily video start-up percentiles and stall rates per platform, network, surface and start kind: finished UTC days from playback_metrics_daily_rollup, the rest from playback_metrics.';

-- ─── Indexes for the two new phases that had none ───────────────────────────
--
-- Both partial, so each holds only the rows its phase can still act on. Each
-- build reads its table once under a SHARE lock (both tables are a few hundred
-- rows) and waits at most five seconds for the lock itself: a plain SET, reset
-- after the builds, because SET LOCAL is a no-op outside a transaction block
-- (see 20261104135153). onboarding_events (created_at), playback_metrics (received_at) and
-- backend_job_locks need none: the first two are indexed on their window
-- already, and a lock row is read by name alone; an index on locked_until
-- would end the heap-only updates every lock renewal makes, for a daily scan
-- of a small table.
SET lock_timeout = '5s';

CREATE INDEX mobile_notifications_unread_retention_idx
  ON public.mobile_notifications (updated_at, id)
  WHERE is_read = false;

CREATE INDEX ai_usage_events_payload_retention_idx
  ON public.ai_usage_events (created_at, id)
  WHERE input_prompt IS NOT NULL OR output_text IS NOT NULL OR response_payload IS NOT NULL;

RESET lock_timeout;

-- ─── The sweep ──────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer
);

-- The first eight parameters and their phases are reproduced from
-- 20261010071057_skip_locked_operational_retention.sql unchanged.
CREATE FUNCTION public.prune_operational_backend_data(
  p_now timestamptz DEFAULT now(),
  p_job_run_retention_days integer DEFAULT 30,
  p_skipped_job_run_retention_days integer DEFAULT 7,
  p_rate_limit_retention_days integer DEFAULT 2,
  p_completion_job_retention_days integer DEFAULT 14,
  p_provider_event_retention_days integer DEFAULT 30,
  p_provider_check_retention_days integer DEFAULT 60,
  p_max_deletes_per_table integer DEFAULT 5000,
  p_playback_metric_retention_days integer DEFAULT 90,
  p_onboarding_event_retention_days integer DEFAULT 365,
  p_ai_usage_payload_retention_days integer DEFAULT 90,
  p_unread_notification_retention_days integer DEFAULT 365,
  p_expired_job_lock_retention_days integer DEFAULT 1
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
  v_playback_days_rolled_up integer := 0;
  v_playback_metrics_deleted integer := 0;
  v_onboarding_events_deleted integer := 0;
  v_ai_usage_payloads_cleared integer := 0;
  v_unread_notifications_deleted integer := 0;
  v_expired_job_locks_deleted integer := 0;
  v_now timestamptz := coalesce(p_now, now());
  v_max_deletes integer := greatest(1, coalesce(p_max_deletes_per_table, 5000));
  v_today timestamptz := date_trunc('day', coalesce(p_now, now()), 'UTC');
BEGIN
  IF p_job_run_retention_days < 1
     OR p_skipped_job_run_retention_days < 1
     OR p_rate_limit_retention_days < 1
     OR p_completion_job_retention_days < 1
     OR p_provider_event_retention_days < 1
     OR p_provider_check_retention_days < 1
     OR p_playback_metric_retention_days < 1
     OR p_onboarding_event_retention_days < 1
     OR p_ai_usage_payload_retention_days < 1
     OR p_unread_notification_retention_days < 1
     OR p_expired_job_lock_retention_days < 1 THEN
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
    ORDER BY started_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.backend_job_runs AS runs
  USING prunable
  WHERE runs.id = prunable.id;
  GET DIAGNOSTICS v_job_runs_deleted = ROW_COUNT;

  -- Rate-limit counters are windowed; once the window is well past, the row can
  -- never affect a decision again. backend_rate_limits_window_start_idx
  -- (20261104135153) is in this batch's order.
  WITH prunable AS (
    SELECT scope, subject_key, window_start
    FROM public.backend_rate_limits
    WHERE window_start < v_now - make_interval(days => p_rate_limit_retention_days)
    ORDER BY window_start, scope, subject_key
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
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
    ORDER BY coalesce(completed_at, updated_at, created_at), id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
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
    ORDER BY created_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
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
    ORDER BY checks.checked_at, checks.id
    LIMIT v_max_deletes
    FOR UPDATE OF checks SKIP LOCKED
  )
  DELETE FROM public.generation_model_provider_checks AS checks
  USING prunable
  WHERE checks.id = prunable.id;
  GET DIAGNOSTICS v_provider_checks_deleted = ROW_COUNT;

  -- Playback, step one: every finished UTC day with raw rows that is not rolled
  -- up yet is aggregated, the whole day in one statement, exactly as the view
  -- aggregates it. received_at is the server's clock at insert, so a day that
  -- has ended receives no more rows and its rollup is final. A day already
  -- rolled up is never recomputed: its raw rows may be partly gone.
  WITH finished AS (
    SELECT m.*, date_trunc('day', m.received_at, 'UTC') AS day
    FROM public.playback_metrics AS m
    WHERE m.received_at < v_today
      AND NOT EXISTS (
        SELECT 1 FROM public.playback_metrics_daily_rollup AS rollup
        WHERE rollup.day = date_trunc('day', m.received_at, 'UTC')
      )
  ),
  percentiles AS (
    SELECT
      samples.day, samples.platform, samples.network, samples.surface, samples.start_kind,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY samples.start_ms) AS start_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY samples.start_ms) AS start_p95_ms
    FROM (
      SELECT day, platform, network, surface, start_kind, unnest(start_samples) AS start_ms
      FROM finished
    ) AS samples
    GROUP BY samples.day, samples.platform, samples.network, samples.surface, samples.start_kind
  ),
  rolled AS (
    INSERT INTO public.playback_metrics_daily_rollup (
      day, platform, network, surface, start_kind, sessions, starts, start_total_ms,
      start_max_ms, start_p50_ms, start_p95_ms, stalls, stall_total_ms, stall_max_ms
    )
    SELECT
      m.day, m.platform, m.network, m.surface, m.start_kind,
      count(DISTINCT m.session_id),
      sum(m.starts),
      sum(m.start_total_ms),
      max(m.start_max_ms),
      p.start_p50_ms,
      p.start_p95_ms,
      sum(m.stalls),
      sum(m.stall_total_ms),
      max(m.stall_max_ms)
    FROM finished AS m
    LEFT JOIN percentiles AS p
      ON p.day = m.day
     AND p.platform = m.platform
     AND p.network = m.network
     AND p.surface = m.surface
     AND p.start_kind = m.start_kind
    GROUP BY m.day, m.platform, m.network, m.surface, m.start_kind, p.start_p50_ms, p.start_p95_ms
    ON CONFLICT (day, platform, network, surface, start_kind) DO NOTHING
    RETURNING day
  )
  SELECT count(DISTINCT rolled.day) INTO v_playback_days_rolled_up FROM rolled;

  -- Playback, step two: raw rows of whole UTC days past the window, and only of
  -- a day the rollup holds, so no day's numbers are ever lost.
  WITH prunable AS (
    SELECT m.id
    FROM public.playback_metrics AS m
    WHERE m.received_at < v_today - make_interval(days => p_playback_metric_retention_days)
      AND EXISTS (
        SELECT 1 FROM public.playback_metrics_daily_rollup AS rollup
        WHERE rollup.day = date_trunc('day', m.received_at, 'UTC')
      )
    ORDER BY m.received_at, m.id
    LIMIT v_max_deletes
    FOR UPDATE OF m SKIP LOCKED
  )
  DELETE FROM public.playback_metrics AS metrics
  USING prunable
  WHERE metrics.id = prunable.id;
  GET DIAGNOSTICS v_playback_metrics_deleted = ROW_COUNT;

  -- Onboarding funnel events, by the server's clock.
  WITH prunable AS (
    SELECT client_event_id
    FROM public.onboarding_events
    WHERE created_at < v_now - make_interval(days => p_onboarding_event_retention_days)
    ORDER BY created_at, client_event_id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.onboarding_events AS events
  USING prunable
  WHERE events.client_event_id = prunable.client_event_id;
  GET DIAGNOSTICS v_onboarding_events_deleted = ROW_COUNT;

  -- A settled AI usage event keeps its accounting and loses its text. The
  -- update touches neither `refunded` (whose trigger restores promotional
  -- credits) nor any column a ledger, history or report reads.
  WITH clearable AS (
    SELECT id
    FROM public.ai_usage_events
    WHERE status IN ('succeeded', 'failed', 'refunded')
      AND created_at < v_now - make_interval(days => p_ai_usage_payload_retention_days)
      AND (input_prompt IS NOT NULL OR output_text IS NOT NULL OR response_payload IS NOT NULL)
    ORDER BY created_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_usage_events AS events
  SET input_prompt = NULL,
      output_text = NULL,
      response_payload = NULL
  FROM clearable
  WHERE events.id = clearable.id;
  GET DIAGNOSTICS v_ai_usage_payloads_cleared = ROW_COUNT;

  -- Unread alerts nobody opened in a year. A delivery that pushed one keeps
  -- its row with a null alert (ON DELETE SET NULL).
  WITH prunable AS (
    SELECT id
    FROM public.mobile_notifications
    WHERE is_read = false
      AND updated_at < v_now - make_interval(days => p_unread_notification_retention_days)
    ORDER BY updated_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.mobile_notifications AS notifications
  USING prunable
  WHERE notifications.id = prunable.id;
  GET DIAGNOSTICS v_unread_notifications_deleted = ROW_COUNT;

  -- Lock rows long past their expiry. A lock a worker holds or renews has a
  -- locked_until in the future, and one an acquire is taking over right now is
  -- row-locked and skipped. No ORDER BY: any expired rows will do, and the scan
  -- stops at the batch.
  WITH prunable AS (
    SELECT name
    FROM public.backend_job_locks
    WHERE locked_until < v_now - make_interval(days => p_expired_job_lock_retention_days)
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.backend_job_locks AS locks
  USING prunable
  WHERE locks.name = prunable.name
    AND locks.locked_until < v_now - make_interval(days => p_expired_job_lock_retention_days);
  GET DIAGNOSTICS v_expired_job_locks_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'job_runs_deleted', v_job_runs_deleted,
    'rate_limits_deleted', v_rate_limits_deleted,
    'completion_jobs_deleted', v_completion_jobs_deleted,
    'provider_events_deleted', v_provider_events_deleted,
    'provider_checks_deleted', v_provider_checks_deleted,
    'playback_days_rolled_up', v_playback_days_rolled_up,
    'playback_metrics_deleted', v_playback_metrics_deleted,
    'onboarding_events_deleted', v_onboarding_events_deleted,
    'ai_usage_payloads_cleared', v_ai_usage_payloads_cleared,
    'unread_notifications_deleted', v_unread_notifications_deleted,
    'expired_job_locks_deleted', v_expired_job_locks_deleted,
    'total_deleted', v_job_runs_deleted
      + v_rate_limits_deleted
      + v_completion_jobs_deleted
      + v_provider_events_deleted
      + v_provider_checks_deleted
      + v_playback_metrics_deleted
      + v_onboarding_events_deleted
      + v_unread_notifications_deleted
      + v_expired_job_locks_deleted,
    'batch_limit_reached', (
      v_job_runs_deleted >= v_max_deletes
      OR v_rate_limits_deleted >= v_max_deletes
      OR v_completion_jobs_deleted >= v_max_deletes
      OR v_provider_events_deleted >= v_max_deletes
      OR v_provider_checks_deleted >= v_max_deletes
      OR v_playback_metrics_deleted >= v_max_deletes
      OR v_onboarding_events_deleted >= v_max_deletes
      OR v_ai_usage_payloads_cleared >= v_max_deletes
      OR v_unread_notifications_deleted >= v_max_deletes
      OR v_expired_job_locks_deleted >= v_max_deletes
    ),
    'pruned_at', v_now
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.prune_operational_backend_data(
  timestamptz, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) IS 'Bounded retention sweep, one batch per table per call: job runs, rate limits, completion jobs, provider telemetry and checks, playback metrics (rolled up by UTC day first), onboarding events, settled AI usage payloads (cleared, never the accounting), unread alerts and expired job locks. Windows are parameter defaults. Never touches creator content or feed analytics.';

-- The anonymous search log (search phase 2, 2026-11-12): one row per first-page
-- /api/search answer, so the ranking work has a zero-result rate and a list of
-- failing queries to tune against. Written by the service role behind the
-- response (src/lib/public-search-query-log.ts), never in the way of it.
--
-- What a row holds, and nothing else about the person:
--   * the normalized query the search ran on, lowercased, at most 100 characters;
--   * the search type (top, creators, posts, recipes);
--   * whether a registered (non-guest) account was presented;
--   * visitor_day: HMAC-SHA256 of the viewer's rate-limit key (the user id or
--     the hashed network address, never stored) under a random key made for
--     that UTC day alone (search_visitor_day_keys, below). The key is deleted by
--     the retention sweep once the day is more than 48 hours old, after which
--     nobody, operators included, can recompute a visitor_day from an account or
--     an address. Until then the hash is pseudonymous to whoever holds the
--     service role, and no more. It lets the report treat "po" -> "por" ->
--     "port" from one visitor as one search, and a visitor is never joined
--     across days;
--   * how many creators, posts and recipes the answer held;
--   * created_at, when the request arrived (the adapter's clock, so a slow
--     answer logged late still sorts where it was asked).
--
-- Append-only: the service role may SELECT and INSERT and nothing else (a new
-- table is born with the full service_role grant set, cut here). Retention
-- deletes as the sweep's owner, so service_role needs no DELETE. Rows are kept
-- 90 days (prune_operational_backend_data, below).

CREATE TABLE public.search_query_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 100),
  search_type text NOT NULL CHECK (search_type IN ('top', 'creators', 'posts', 'recipes')),
  signed_in boolean NOT NULL,
  visitor_day text NOT NULL CHECK (visitor_day ~ '^[0-9a-f]{64}$'),
  creator_count integer NOT NULL CHECK (creator_count >= 0),
  post_count integer NOT NULL CHECK (post_count >= 0),
  recipe_count integer NOT NULL CHECK (recipe_count >= 0)
);

COMMENT ON TABLE public.search_query_events IS
  'Anonymous log of first-page /api/search answers: normalized query, type, registered-account flag, a per-day visitor hash and result counts. Written by the service role, kept 90 days, read by search_query_report.';

-- The report's window and the retention sweep both read by created_at.
CREATE INDEX search_query_events_created_at_idx
  ON public.search_query_events (created_at, id);

ALTER TABLE public.search_query_events ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing.
REVOKE ALL ON TABLE public.search_query_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.search_query_events TO service_role;

-- ─── The day keys ───────────────────────────────────────────────────────────
--
-- One random key per UTC day, the HMAC key of that day's visitor_day values. The
-- logger reads it through search_visitor_day_key, which makes it on first use:
-- ON CONFLICT DO NOTHING, so concurrent instances all get the one that won.
-- The sweep deletes a key once its day started more than 48 hours ago.

CREATE TABLE public.search_visitor_day_keys (
  day date PRIMARY KEY,
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.search_visitor_day_keys IS
  'One random HMAC key per UTC day for search_query_events.visitor_day. Deleted by the retention sweep after 48 hours, which makes the day''s visitor hashes unrecomputable. Service role only.';

ALTER TABLE public.search_visitor_day_keys ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.search_visitor_day_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.search_visitor_day_keys TO service_role;

CREATE FUNCTION public.search_visitor_day_key(p_day date)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_key text;
BEGIN
  INSERT INTO public.search_visitor_day_keys (day, key)
  VALUES (p_day, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  ON CONFLICT (day) DO NOTHING;

  SELECT k.key INTO v_key FROM public.search_visitor_day_keys AS k WHERE k.day = p_day;
  RETURN v_key;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_visitor_day_key(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_visitor_day_key(date) TO service_role;

COMMENT ON FUNCTION public.search_visitor_day_key(date) IS
  'The HMAC key of a UTC day''s search visitor hashes, made on first call. Service role only.';

-- ─── The report ─────────────────────────────────────────────────────────────
--
-- A visitor-day's rows, in arrival order, split into chains: a row is a typing
-- step when the next row is within 15 seconds and starts with it (an equal query
-- is its own prefix, so a tab switch is a step); the row that is no step ends its
-- chain and names it. Each step only has to be within 15 seconds of the next, so
-- "po" -> "por" -> "port" is one search, "port". Within a chain, the rows with the
-- final query's text are one search, zero-result only if every one of them found
-- nothing: Top finding posts and Creators finding none is not a failed search.
-- A visitor-day on the same final query twice counts once. Each row is compared
-- with the next one only (lead()), so the cost is a sort, not a self-join. Every
-- row also carries the window's totals, computed before the limit, so a
-- zero-result rate is one division.

CREATE FUNCTION public.search_query_report(
  p_days integer DEFAULT 7,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  query text,
  searches bigint,
  zero_result_searches bigint,
  total_searches bigint,
  total_zero_result_searches bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'search_query_report: p_days must be between 1 and 90';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'search_query_report: p_limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  WITH windowed AS (
    SELECT e.id, e.created_at, e.query, e.visitor_day,
           (e.creator_count = 0 AND e.post_count = 0 AND e.recipe_count = 0) AS is_zero
    FROM public.search_query_events AS e
    WHERE e.created_at >= now() - make_interval(days => p_days)
  ),
  stepped AS (
    SELECT w.*,
           coalesce(
             lead(w.created_at) OVER visitor <= w.created_at + interval '15 seconds'
             AND starts_with(lead(w.query) OVER visitor, w.query),
             false
           ) AS is_step
    FROM windowed AS w
    WINDOW visitor AS (PARTITION BY w.visitor_day ORDER BY w.created_at, w.id)
  ),
  chained AS (
    SELECT s.*,
           coalesce(
             sum((NOT s.is_step)::integer) OVER (
               PARTITION BY s.visitor_day ORDER BY s.created_at, s.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ), 0
           ) AS chain_no
    FROM stepped AS s
  ),
  named AS (
    SELECT c.*,
           max(c.query) FILTER (WHERE NOT c.is_step) OVER (PARTITION BY c.visitor_day, c.chain_no) AS final_query
    FROM chained AS c
  ),
  per_visitor AS (
    SELECT n.query, n.visitor_day, bool_and(n.is_zero) AS is_zero
    FROM named AS n
    WHERE n.query = n.final_query
    GROUP BY n.query, n.visitor_day
  ),
  per_query AS (
    SELECT p.query,
           count(*) AS searches,
           count(*) FILTER (WHERE p.is_zero) AS zero_result_searches
    FROM per_visitor AS p
    GROUP BY p.query
  )
  SELECT q.query,
         q.searches,
         q.zero_result_searches,
         sum(q.searches) OVER ()::bigint,
         sum(q.zero_result_searches) OVER ()::bigint
  FROM per_query AS q
  ORDER BY q.zero_result_searches DESC, q.searches DESC, q.query
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_query_report(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_query_report(integer, integer) TO service_role;

COMMENT ON FUNCTION public.search_query_report(integer, integer) IS
  'Per final query over the last p_days: distinct visitor-days that searched it and how many of those got zero results in every kind and every tab, zero-result searches first, with the window totals on every row. Service role only.';

-- ─── Retention: the sweep gains one phase ───────────────────────────────────
--
-- The sweep keeps its thirteen-parameter signature (its callers and tests name
-- it); everything before the new phase is reproduced from
-- 20261104135403_operational_retention_covers_unbounded_tables.sql unchanged.

CREATE OR REPLACE FUNCTION public.prune_operational_backend_data(
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
  v_search_query_events_deleted integer := 0;
  v_search_visitor_day_keys_deleted integer := 0;
  -- The search log's window. A constant, not a parameter: the sweep's signature is pinned by its
  -- callers and tests, and a new window changes it by a migration either way.
  v_search_query_retention_days CONSTANT integer := 90;
  -- A day's visitor-hash key lives 48 hours from the day's start; deleting it is what
  -- makes that day's visitor_day values unrecomputable.
  v_search_day_key_retention CONSTANT interval := interval '48 hours';
  -- The sweep's clock: the caller's, never later than the database's own. A
  -- caller's clock ahead of it cannot make any row expire sooner: not delete a
  -- lock still held, nor roll up a day still taking rows, nor prune a day early.
  -- An earlier one (a backfill, a test's 1901) is taken as given.
  v_now timestamptz := least(coalesce(p_now, now()), now());
  v_max_deletes integer := greatest(1, coalesce(p_max_deletes_per_table, 5000));
  -- The UTC day the playback phases treat as unfinished.
  v_today timestamptz := date_trunc('day', least(coalesce(p_now, now()), now()), 'UTC');
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

  -- The anonymous search log, by the server's clock. Append-only for every
  -- role; this sweep runs as its owner, which is the only thing that deletes.
  WITH prunable AS (
    SELECT id
    FROM public.search_query_events
    WHERE created_at < v_now - make_interval(days => v_search_query_retention_days)
    ORDER BY created_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.search_query_events AS events
  USING prunable
  WHERE events.id = prunable.id;
  GET DIAGNOSTICS v_search_query_events_deleted = ROW_COUNT;

  -- The day keys: a handful of rows, so one plain delete.
  DELETE FROM public.search_visitor_day_keys AS keys
  WHERE keys.day::timestamp AT TIME ZONE 'UTC' < v_now - v_search_day_key_retention;
  GET DIAGNOSTICS v_search_visitor_day_keys_deleted = ROW_COUNT;

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
    'search_query_events_deleted', v_search_query_events_deleted,
    'search_visitor_day_keys_deleted', v_search_visitor_day_keys_deleted,
    'total_deleted', v_job_runs_deleted
      + v_rate_limits_deleted
      + v_completion_jobs_deleted
      + v_provider_events_deleted
      + v_provider_checks_deleted
      + v_playback_metrics_deleted
      + v_onboarding_events_deleted
      + v_unread_notifications_deleted
      + v_expired_job_locks_deleted
      + v_search_query_events_deleted
      + v_search_visitor_day_keys_deleted,
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
      OR v_search_query_events_deleted >= v_max_deletes
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
) IS 'Bounded retention sweep, one batch per table per call: job runs, rate limits, completion jobs, provider telemetry and checks, playback metrics (rolled up by UTC day first), onboarding events, settled AI usage payloads (cleared, never the accounting), unread alerts, expired job locks, search log rows older than 90 days and search day keys older than 48 hours. Windows are parameter defaults, the search log''s and the keys'' constants. Never touches creator content or feed analytics.';

-- ─── Growth accounting ──────────────────────────────────────────────────────
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
        'search_query_events',
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

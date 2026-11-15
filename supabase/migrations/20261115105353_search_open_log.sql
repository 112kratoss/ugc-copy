-- The search log learns how a search was entered and which result was opened
-- (search benchmark 2026-11-15, gap 4; owner 2026-11-15). Ranking cannot be
-- tuned on what was searched alone: this adds the two signals it lacks, under
-- the privacy rules the log already keeps (20261112084002).
--
-- 1. search_query_events.entry: how the search was started, as the client
--    says it: typed, a completion row, a model or tool row, a recent search, a
--    start-screen row, a related-search chip, or an address or deep link.
--    NULL for a client that sends none (every installed one) and for every
--    row written before this file. "Search instead for" is no entry: it reads
--    the same query another way, and a search read as typed writes no row.
--
-- 2. search_result_opens: one row per result a person pressed, written by the
--    service role behind POST /api/search/opened
--    (src/lib/search-open-log.ts). What a row holds, and nothing else about
--    the person:
--      * the query as searched, cleaned as the log cleans one (lowercased,
--        control characters removed, at most 100 characters);
--      * the tab it was pressed on, the order of a Posts or Recipes list, and
--        the search's entry;
--      * visitor_day: the same per-UTC-day HMAC as the search row
--        (search_visitor_day_keys), so an open is tied to its search within
--        that day and to nothing else. No user id, no network address, and
--        after the day key is deleted (48 hours) nothing can recompute it;
--      * what was opened: its kind, its id (a uuid, or an entity's
--        model:<key> / tool:<key>) and its 1-based position in the list it
--        was pressed in;
--      * created_at, when the request arrived.
--    The route stores what it is sent without asking whether the id exists
--    or may be seen, so its answer says nothing about either. The report
--    below counts an open only while its id is a public thing search shows.
--
--    A table of its own, not rows of search_query_events: an open has no
--    result counts and a search has no result id, so one table would make
--    every column of both nullable and its checks conditional; and everything
--    that reads the search log today (the report, the app live during the
--    release, any reader added beside this file) would have to learn to skip
--    the new rows. Apart, nothing that exists changes meaning.
--
-- 3. search_query_report: dropped and re-created (a result column cannot be
--    added by CREATE OR REPLACE) with the opens joined in. Its first five
--    columns and its two-argument call are unchanged, so an older checkout's
--    CLI still reads it.
--
-- 4. The retention sweep gains one phase (opens older than 90 days), and the
--    growth accounting one table.
--
-- Deployment: this file applies before the code that reads it. The app live
-- during the release inserts search rows without `entry` (NULL), calls nothing
-- that this file drops, and writes no opens.
--
-- Locks: ACCESS EXCLUSIVE on search_query_events for the column and its check
-- (a scan of at most 90 days of rows; a search's log insert, which runs behind
-- its answer, waits for it).

-- ─── 1. How a search was entered ────────────────────────────────────────────

ALTER TABLE public.search_query_events
  ADD COLUMN entry text CHECK (entry IS NULL OR entry IN ('typed', 'suggestion', 'entity', 'recent', 'starter', 'related', 'link'));

COMMENT ON COLUMN public.search_query_events.entry IS
  'How the search was started, as the client says it: typed, suggestion (a completion row), entity (a model or tool row), recent, starter (a start-screen row), related (a related-search chip) or link (an address or deep link). NULL when the client sent none.';

-- ─── 2. The opened results ──────────────────────────────────────────────────

CREATE TABLE public.search_result_opens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 100),
  search_type text NOT NULL CHECK (search_type IN ('top', 'creators', 'posts', 'recipes')),
  sort text CHECK (sort IS NULL OR sort IN ('top', 'latest')),
  entry text CHECK (entry IS NULL OR entry IN ('typed', 'suggestion', 'entity', 'recent', 'starter', 'related', 'link')),
  visitor_day text NOT NULL CHECK (visitor_day ~ '^[0-9a-f]{64}$'),
  result_kind text NOT NULL CHECK (result_kind IN ('post', 'creator', 'recipe', 'entity')),
  result_id text NOT NULL,
  result_position integer NOT NULL CHECK (result_position BETWEEN 1 AND 500),
  -- A post, creator or recipe is named by its uuid, an entity by the id a
  -- made-with filter names it by. Nothing else fits: not a handle, not a URL.
  CONSTRAINT search_result_opens_result_id_shape CHECK (
    CASE
      WHEN result_kind = 'entity' THEN result_id ~ '^(model|tool):[^[:space:]:/?#&%"''<>\\]{1,80}$'
      ELSE result_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    END
  )
);

COMMENT ON TABLE public.search_result_opens IS
  'Anonymous log of results opened from a search: the cleaned query, tab, order and entry of the search, the same per-day visitor hash as search_query_events, and the kind, id and 1-based position of what was pressed. Stored as sent, never checked for existence. Written by the service role, kept 90 days, read by search_query_report.';

-- The report window and the retention sweep both read by created_at.
CREATE INDEX search_result_opens_created_at_idx
  ON public.search_result_opens (created_at, id);

ALTER TABLE public.search_result_opens ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing. Append-only for the
-- service role; the sweep deletes as its owner.
REVOKE ALL ON TABLE public.search_result_opens FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.search_result_opens TO service_role;

-- ─── 3. The report ──────────────────────────────────────────────────────────
--
-- The chains are those of 20261112084002: a visitor-day's rows in arrival
-- order, a row a typing step when the next one is within 15 seconds and starts
-- with it, each compared with the next row only (lead()), and a search one
-- (final query, visitor-day). Added:
--
--   * an open belongs to the search of its visitor-day and query. A query a
--     result was opened from is never a typing step, however soon the person
--     typed on: they searched it and chose from it;
--   * an open counts only while its id is something search shows the public:
--     a post with a search document and no NSFW label, a creator with one, a
--     listable recipe, an entity some such post has. A forged, deleted,
--     private or labelled id counts for nothing, here or in any total;
--   * one result opened several times from one search is one open, at the
--     first place it was pressed in;
--   * only a client that says how a search was entered also reports what was
--     opened from it (both arrived together), so a search with no entry, from
--     an app before its update or a tab loaded before the release, is neither
--     opened nor unopened: counting it unopened would fill the table of
--     queries left without an open with whatever old clients search most.
--     reporting_searches: searches with an entry, the ones that could report;
--   * opened_searches: reporting searches with at least one such open.
--     unopened_searches: reporting searches that found something and had none
--     (a search that found nothing has nothing to open, and is counted as
--     zero-result);
--   * mean_open_position: the mean 1-based place of those opens, two decimals,
--     NULL without one;
--   * entry_mix: searches by how they were entered, {"typed": 4, "recent": 1},
--     "unknown" for a client that said nothing. A search asked several times
--     that day takes its first entry;
--   * p_order: 'zero_result' (as before: the failing queries first) or
--     'unopened' (the queries most often left without an open first).
--
-- Every row carries the window totals, computed before the limit.

DROP FUNCTION public.search_query_report(integer, integer);

CREATE FUNCTION public.search_query_report(
  p_days integer DEFAULT 7,
  p_limit integer DEFAULT 50,
  p_order text DEFAULT 'zero_result'
)
RETURNS TABLE (
  query text,
  searches bigint,
  zero_result_searches bigint,
  total_searches bigint,
  total_zero_result_searches bigint,
  opened_searches bigint,
  unopened_searches bigint,
  mean_open_position numeric,
  entry_mix jsonb,
  total_opened_searches bigint,
  total_unopened_searches bigint,
  total_mean_open_position numeric,
  total_entry_mix jsonb,
  reporting_searches bigint,
  total_reporting_searches bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'search_query_report: p_days must be between 1 and 90';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'search_query_report: p_limit must be between 1 and 1000';
  END IF;
  IF p_order IS NULL OR p_order NOT IN ('zero_result', 'unopened') THEN
    RAISE EXCEPTION 'search_query_report: p_order must be zero_result or unopened';
  END IF;

  RETURN QUERY
  WITH open_rows AS (
    SELECT o.visitor_day, o.query, o.result_kind, o.result_id, min(o.result_position) AS result_position
    FROM public.search_result_opens AS o
    WHERE o.created_at >= now() - make_interval(days => p_days)
    GROUP BY o.visitor_day, o.query, o.result_kind, o.result_id
  ),
  -- Each distinct thing opened is looked up once, however many opened it.
  targets AS (
    SELECT DISTINCT r.result_kind, r.result_id FROM open_rows AS r
  ),
  shown AS (
    SELECT t.result_kind, t.result_id
    FROM targets AS t
    WHERE CASE t.result_kind
      WHEN 'post' THEN EXISTS (
        SELECT 1
        FROM public.post_search_documents AS documents
        JOIN public.posts AS posts ON posts.id = documents.post_id
        WHERE documents.post_id = t.result_id::uuid
          AND posts.is_nsfw = false
      )
      WHEN 'creator' THEN EXISTS (
        SELECT 1
        FROM public.creator_search_documents AS documents
        WHERE documents.creator_user_id = t.result_id::uuid
      )
      WHEN 'recipe' THEN EXISTS (
        SELECT 1
        FROM public.marketplace_bundle_listings AS listings
        WHERE listings.bundle_id = t.result_id::uuid
          AND listings.listable
      )
      WHEN 'entity' THEN EXISTS (
        SELECT 1
        FROM public.post_search_entities AS members
        JOIN public.posts AS posts ON posts.id = members.post_id
        WHERE members.kind = split_part(t.result_id, ':', 1)
          AND members.key = substr(t.result_id, strpos(t.result_id, ':') + 1)
          AND posts.is_nsfw = false
      )
      ELSE false
    END
  ),
  opens AS (
    SELECT r.visitor_day, r.query, count(*) AS opens, sum(r.result_position) AS position_sum
    FROM open_rows AS r
    JOIN shown AS s ON s.result_kind = r.result_kind AND s.result_id = r.result_id
    GROUP BY r.visitor_day, r.query
  ),
  windowed AS (
    SELECT e.id, e.created_at, e.query, e.visitor_day, e.entry,
           (e.creator_count = 0 AND e.post_count = 0 AND e.recipe_count = 0) AS is_zero,
           o.opens, o.position_sum
    FROM public.search_query_events AS e
    LEFT JOIN opens AS o ON o.visitor_day = e.visitor_day AND o.query = e.query
    WHERE e.created_at >= now() - make_interval(days => p_days)
  ),
  stepped AS (
    SELECT w.*,
           w.opens IS NULL
           AND coalesce(
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
    SELECT n.query, n.visitor_day,
           bool_and(n.is_zero) AS is_zero,
           coalesce(
             (array_agg(n.entry ORDER BY n.created_at, n.id) FILTER (WHERE n.entry IS NOT NULL))[1],
             'unknown'
           ) AS entry,
           max(n.opens) AS opens,
           max(n.position_sum) AS position_sum
    FROM named AS n
    WHERE n.query = n.final_query
    GROUP BY n.query, n.visitor_day
  ),
  entry_counts AS (
    SELECT p.query, p.entry, count(*) AS searches
    FROM per_visitor AS p
    GROUP BY p.query, p.entry
  ),
  entry_mixes AS (
    SELECT c.query, jsonb_object_agg(c.entry, c.searches) AS entry_mix
    FROM entry_counts AS c
    GROUP BY c.query
  ),
  entry_totals AS (
    SELECT jsonb_object_agg(t.entry, t.searches) AS entry_mix
    FROM (
      SELECT c.entry, sum(c.searches)::bigint AS searches
      FROM entry_counts AS c
      GROUP BY c.entry
    ) AS t
  ),
  per_query AS (
    SELECT p.query,
           count(*) AS searches,
           count(*) FILTER (WHERE p.is_zero) AS zero_result_searches,
           count(*) FILTER (WHERE p.entry <> 'unknown') AS reporting_searches,
           count(*) FILTER (WHERE p.entry <> 'unknown' AND p.opens IS NOT NULL) AS opened_searches,
           count(*) FILTER (WHERE p.entry <> 'unknown' AND p.opens IS NULL AND NOT p.is_zero) AS unopened_searches,
           coalesce(sum(p.opens) FILTER (WHERE p.entry <> 'unknown'), 0) AS opens,
           coalesce(sum(p.position_sum) FILTER (WHERE p.entry <> 'unknown'), 0) AS position_sum
    FROM per_visitor AS p
    GROUP BY p.query
  )
  SELECT q.query,
         q.searches,
         q.zero_result_searches,
         sum(q.searches) OVER ()::bigint,
         sum(q.zero_result_searches) OVER ()::bigint,
         q.opened_searches,
         q.unopened_searches,
         round(q.position_sum / nullif(q.opens, 0), 2),
         m.entry_mix,
         sum(q.opened_searches) OVER ()::bigint,
         sum(q.unopened_searches) OVER ()::bigint,
         round(sum(q.position_sum) OVER () / nullif(sum(q.opens) OVER (), 0), 2),
         (SELECT t.entry_mix FROM entry_totals AS t),
         q.reporting_searches,
         sum(q.reporting_searches) OVER ()::bigint
  FROM per_query AS q
  JOIN entry_mixes AS m ON m.query = q.query
  ORDER BY
    CASE WHEN p_order = 'unopened' THEN q.unopened_searches ELSE q.zero_result_searches END DESC,
    q.searches DESC,
    q.query
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_query_report(integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_query_report(integer, integer, text) TO service_role;

COMMENT ON FUNCTION public.search_query_report(integer, integer, text) IS
  'Per final query over the last p_days: distinct visitor-days that searched it, how many got zero results in every kind and every tab, how many came from a client that reports opens (it said how the search was entered), how many of those opened a result search still shows the public, how many of those found something and opened nothing, the mean place opened and how the searches were entered, with the window totals on every row; zero-result searches first, or with p_order = unopened the queries most often left without an open. Service role only.';

-- ─── 4. Retention: the sweep gains one phase ────────────────────────────────
--
-- The definition of 20261112084002 unchanged, its thirteen-parameter signature
-- included, with the opens pruned on the search log's 90 days and counted as
-- search_result_opens_deleted.

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
  v_search_result_opens_deleted integer := 0;
  -- The search log's window, for its searches and its opened results alike. A constant, not a parameter: the sweep's signature is pinned by its
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

  -- The opened results of the search log: the same window, the same rule.
  WITH prunable AS (
    SELECT id
    FROM public.search_result_opens
    WHERE created_at < v_now - make_interval(days => v_search_query_retention_days)
    ORDER BY created_at, id
    LIMIT v_max_deletes
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.search_result_opens AS opens
  USING prunable
  WHERE opens.id = prunable.id;
  GET DIAGNOSTICS v_search_result_opens_deleted = ROW_COUNT;

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
    'search_result_opens_deleted', v_search_result_opens_deleted,
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
      + v_search_visitor_day_keys_deleted
      + v_search_result_opens_deleted,
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
      OR v_search_result_opens_deleted >= v_max_deletes
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
) IS 'Bounded retention sweep, one batch per table per call: job runs, rate limits, completion jobs, provider telemetry and checks, playback metrics (rolled up by UTC day first), onboarding events, settled AI usage payloads (cleared, never the accounting), unread alerts, expired job locks, search log rows and opened-result rows older than 90 days and search day keys older than 48 hours. Windows are parameter defaults, the search log''s and the keys'' constants. Never touches creator content or feed analytics.';

-- ─── 5. Growth accounting counts the new table ──────────────────────────────
--
-- The definition of 20261112215420 with search_result_opens added.
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
        'post_search_embeddings',
        'provider_dependency_events',
        'search_query_embeddings',
        'search_query_events',
        'search_result_opens',
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
  'Row counts and byte sizes for churn-prone operational state, append-only telemetry with retention, the vectors search keeps of posts and of queries, permanent security ledgers, user-owned workflow history, auth.users and the exact count of live guest identities (bytes 0: part of auth.users). Service role only.';

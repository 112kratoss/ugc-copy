-- F12 (scaling audit 2026-08-08): workflow runs are non-durable and
-- non-idempotent. Two defects, fixed in one migration because they share the
-- same tables:
--
--   1. Run creation had no idempotency binding, so a timed-out client retry
--      created a second run that re-charged every node's generation.
--      Per-generation idempotency cannot help here -- each new run
--      legitimately starts new generations, so the duplicate has to be caught
--      at the run boundary or not at all. This is the money half.
--   2. Progress depended on a process-local monitor map plus client polling,
--      and the cron registry had no workflow entry at all, so a recycled
--      function stranded a run with no server-side recovery.
--
-- The queue below is modelled on generation_completion_jobs (20260621111546)
-- deliberately: claims, backoff, attempt caps and lock reclaim are already
-- proven there, and one queue idiom is cheaper to operate than two. The one
-- structural departure is that a retry is a NEW row (attempt + 1) rather than
-- a mutated counter, because the audit specifies unique
-- (run_id, node_id, attempt) -- which buys an immutable per-attempt trail for
-- answering "was this node charged twice?".

-- ---------------------------------------------------------------------------
-- 1. Idempotent run creation
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_canvas_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Partial rather than plain. Postgres already treats NULLs as distinct, so the
-- predicate is not what makes keyless inserts possible -- it is what lets
-- ON CONFLICT below name this index, and what documents that a keyless run is
-- a deliberate path (historical rows, and any future caller that genuinely
-- wants an unconditional run) rather than an oversight.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_canvas_runs_canvas_idempotency_key_idx
  ON public.workflow_canvas_runs (canvas_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.start_workflow_canvas_run(
  p_canvas_id uuid,
  p_user_id uuid,
  p_start_node_id text,
  p_mode text,
  p_catalog_revision text,
  p_graph_snapshot jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS TABLE (
  run_id uuid,
  run_status text,
  run_created_at timestamptz,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_run public.workflow_canvas_runs%ROWTYPE;
BEGIN
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

  IF btrim(coalesce(p_start_node_id, '')) = '' THEN
    RAISE EXCEPTION 'start_node_id is required';
  END IF;

  IF coalesce(p_mode, '') NOT IN ('node', 'branch') THEN
    RAISE EXCEPTION 'mode must be node or branch';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so ownership is re-checked here rather than
  -- trusted from the caller. The route checks it too; this is the boundary.
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_canvases
    WHERE id = p_canvas_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'workflow canvas not found for this user';
  END IF;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');

  IF v_key IS NULL THEN
    INSERT INTO public.workflow_canvas_runs (
      canvas_id, user_id, start_node_id, mode, status,
      catalog_revision, graph_snapshot, idempotency_key
    )
    VALUES (
      p_canvas_id, p_user_id, btrim(p_start_node_id), p_mode, 'processing',
      p_catalog_revision, p_graph_snapshot, NULL
    )
    RETURNING * INTO v_run;

    RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, false;
    RETURN;
  END IF;

  INSERT INTO public.workflow_canvas_runs (
    canvas_id, user_id, start_node_id, mode, status,
    catalog_revision, graph_snapshot, idempotency_key
  )
  VALUES (
    p_canvas_id, p_user_id, btrim(p_start_node_id), p_mode, 'processing',
    p_catalog_revision, p_graph_snapshot, v_key
  )
  ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_run;

  IF v_run.id IS NOT NULL THEN
    RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, false;
    RETURN;
  END IF;

  -- Either a genuine replay or a lost insert race. Both hand back the run the
  -- key already names; never a second run, which is the entire point. The
  -- existing row is returned untouched -- deliberately NOT an upsert, because
  -- overwriting graph_snapshot on a replay would rewrite history for a run
  -- that may already be mid-flight.
  SELECT * INTO v_run
  FROM public.workflow_canvas_runs
  WHERE canvas_id = p_canvas_id AND idempotency_key = v_key;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'idempotent workflow run lookup failed for key %', v_key;
  END IF;

  RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Durable step queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_run_step_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.workflow_canvas_runs(id) ON DELETE CASCADE,
  -- Denormalised from the run. Every runner entry point is keyed on
  -- (canvasId, runId), so carrying it here keeps the worker from re-reading
  -- the run row just to learn which canvas to advance.
  canvas_id uuid NOT NULL REFERENCES public.workflow_canvases(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT workflow_run_step_jobs_node_id_not_blank CHECK (btrim(node_id) <> ''),
  CONSTRAINT workflow_run_step_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT workflow_run_step_jobs_attempt_check CHECK (attempt >= 1),
  CONSTRAINT workflow_run_step_jobs_lock_pair_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL AND btrim(locked_by) <> '')
  ),
  -- The audit's idempotency binding: one job per node per attempt. Enqueueing
  -- the same attempt twice is a no-op instead of a second execution.
  CONSTRAINT workflow_run_step_jobs_run_node_attempt_key UNIQUE (run_id, node_id, attempt)
);

CREATE INDEX IF NOT EXISTS workflow_run_step_jobs_due_idx
  ON public.workflow_run_step_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS workflow_run_step_jobs_run_idx
  ON public.workflow_run_step_jobs (run_id, status);

CREATE INDEX IF NOT EXISTS workflow_run_step_jobs_updated_idx
  ON public.workflow_run_step_jobs (updated_at);

ALTER TABLE public.workflow_run_step_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.workflow_run_step_jobs FROM PUBLIC;
REVOKE ALL ON public.workflow_run_step_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_run_step_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_workflow_run_step_job(
  p_run_id uuid,
  p_node_id text,
  p_attempt integer DEFAULT 1
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_id uuid;
  v_canvas_id uuid;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required';
  END IF;

  IF btrim(coalesce(p_node_id, '')) = '' THEN
    RAISE EXCEPTION 'node_id is required';
  END IF;

  IF coalesce(p_attempt, 0) < 1 THEN
    RAISE EXCEPTION 'attempt must be at least 1';
  END IF;

  SELECT canvas_id INTO v_canvas_id
  FROM public.workflow_canvas_runs
  WHERE id = p_run_id;

  IF v_canvas_id IS NULL THEN
    RAISE EXCEPTION 'workflow run % not found', p_run_id;
  END IF;

  INSERT INTO public.workflow_run_step_jobs (
    run_id, canvas_id, node_id, attempt, status, next_attempt_at, updated_at
  )
  VALUES (
    p_run_id, v_canvas_id, btrim(p_node_id), p_attempt, 'pending', now(), now()
  )
  ON CONFLICT ON CONSTRAINT workflow_run_step_jobs_run_node_attempt_key
  DO NOTHING
  RETURNING id INTO v_job_id;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  -- Already enqueued. Return the existing job rather than raising: the caller
  -- asked for this attempt to exist, and it does.
  SELECT id INTO v_job_id
  FROM public.workflow_run_step_jobs
  WHERE run_id = p_run_id AND node_id = btrim(p_node_id) AND attempt = p_attempt;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_workflow_run_step_jobs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS SETOF public.workflow_run_step_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;

  IF p_lock_ttl_seconds < 1 THEN
    RAISE EXCEPTION 'lock ttl must be positive';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.workflow_run_step_jobs
    WHERE (
        (status = 'pending' AND next_attempt_at <= now())
        OR (
          -- Reclaim a lease whose worker died. heartbeat_at is refreshed by a
          -- long-running step, so a node that legitimately takes minutes is
          -- not stolen out from under itself; locked_at is the fallback for a
          -- worker that died before its first heartbeat.
          status = 'processing'
          AND coalesce(heartbeat_at, locked_at) <= now() - make_interval(secs => p_lock_ttl_seconds)
        )
      )
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT least(greatest(coalesce(p_limit, 1), 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.workflow_run_step_jobs
  SET status = 'processing',
      locked_at = now(),
      locked_by = p_locked_by,
      heartbeat_at = now(),
      updated_at = now()
  FROM candidates
  WHERE public.workflow_run_step_jobs.id = candidates.id
  RETURNING public.workflow_run_step_jobs.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_workflow_run_step_job(
  p_id uuid,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;

  UPDATE public.workflow_run_step_jobs
  SET heartbeat_at = now(),
      updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
    AND locked_by = p_locked_by;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- false means the lease was lost (reclaimed by another worker, or the job
  -- was finished elsewhere). The caller should stop work rather than race.
  RETURN v_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_workflow_run_step_job(
  p_id uuid,
  p_locked_by text,
  p_succeeded boolean,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 5
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job public.workflow_run_step_jobs%ROWTYPE;
  v_status text;
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;

  IF p_retry_delay_seconds < 1 THEN
    RAISE EXCEPTION 'retry delay must be positive';
  END IF;

  IF p_max_attempts < 1 THEN
    RAISE EXCEPTION 'max attempts must be positive';
  END IF;

  UPDATE public.workflow_run_step_jobs
  SET status = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
      locked_at = NULL,
      locked_by = NULL,
      heartbeat_at = NULL,
      last_error = CASE WHEN p_succeeded THEN NULL ELSE left(coalesce(p_error, 'Unknown error'), 2000) END,
      completed_at = now(),
      updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
    AND locked_by = p_locked_by
  RETURNING * INTO v_job;

  IF v_job.id IS NULL THEN
    -- Lease lost or already finished. Report the current state instead of
    -- clobbering whatever the winning worker recorded.
    SELECT status INTO v_status FROM public.workflow_run_step_jobs WHERE id = p_id;
    RETURN v_status;
  END IF;

  IF p_succeeded THEN
    RETURN 'succeeded';
  END IF;

  -- A retry is a new row, not a reset counter, so every attempt keeps its own
  -- error and timing. Same transaction as the failure above: the queue can
  -- never be left holding a failed attempt with no successor.
  IF v_job.attempt < p_max_attempts THEN
    INSERT INTO public.workflow_run_step_jobs (
      run_id, canvas_id, node_id, attempt, status, next_attempt_at, updated_at
    )
    VALUES (
      v_job.run_id,
      v_job.canvas_id,
      v_job.node_id,
      v_job.attempt + 1,
      'pending',
      now() + make_interval(secs => p_retry_delay_seconds),
      now()
    )
    ON CONFLICT ON CONSTRAINT workflow_run_step_jobs_run_node_attempt_key
    DO NOTHING;

    RETURN 'retry_scheduled';
  END IF;

  RETURN 'exhausted';
END;
$$;

-- A run that is still legitimately waiting on a provider generation has not
-- failed, so releasing its ticket must not consume the attempt budget --
-- otherwise a long video generation would "retry" itself to exhaustion while
-- nothing was actually wrong. Deferral is therefore its own verb: same row,
-- same attempt, later next_attempt_at.
CREATE OR REPLACE FUNCTION public.defer_workflow_run_step_job(
  p_id uuid,
  p_locked_by text,
  p_delay_seconds integer DEFAULT 60
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;

  IF p_delay_seconds < 1 THEN
    RAISE EXCEPTION 'defer delay must be positive';
  END IF;

  UPDATE public.workflow_run_step_jobs
  SET status = 'pending',
      next_attempt_at = now() + make_interval(secs => p_delay_seconds),
      locked_at = NULL,
      locked_by = NULL,
      heartbeat_at = NULL,
      updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
    AND locked_by = p_locked_by
  RETURNING 'deferred' INTO v_status;

  IF v_status IS NOT NULL THEN
    RETURN v_status;
  END IF;

  SELECT status INTO v_status FROM public.workflow_run_step_jobs WHERE id = p_id;
  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_workflow_run_step_jobs(
  p_run_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cancelled integer;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required';
  END IF;

  UPDATE public.workflow_run_step_jobs
  SET status = 'cancelled',
      locked_at = NULL,
      locked_by = NULL,
      heartbeat_at = NULL,
      completed_at = now(),
      updated_at = now()
  WHERE run_id = p_run_id
    AND status IN ('pending', 'processing');

  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN coalesce(v_cancelled, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_workflow_run_step_jobs(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days < 1 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'retention days must be between 1 and 3650';
  END IF;

  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'prune limit must be between 1 and 10000';
  END IF;

  WITH deleted AS (
    DELETE FROM public.workflow_run_step_jobs
    WHERE id IN (
      SELECT id
      FROM public.workflow_run_step_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
        AND updated_at < now() - make_interval(days => p_retention_days)
      ORDER BY updated_at ASC
      LIMIT p_limit
    )
    RETURNING id
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN coalesce(v_deleted, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_workflow_run_step_job(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_workflow_run_step_jobs(integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.heartbeat_workflow_run_step_job(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_workflow_run_step_job(uuid, text, boolean, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.defer_workflow_run_step_job(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_workflow_run_step_jobs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_workflow_run_step_jobs(integer, integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.enqueue_workflow_run_step_job(uuid, text, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_workflow_run_step_jobs(integer, text, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_workflow_run_step_job(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_workflow_run_step_job(uuid, text, boolean, text, integer, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_workflow_run_step_job(uuid, text, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_workflow_run_step_jobs(uuid) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_workflow_run_step_jobs(integer, integer) FROM anon, authenticated;

-- Run creation is the one function on this path a signed-in user reaches: the
-- canvas run route executes it on the caller's client. It re-checks ownership
-- internally, so SECURITY DEFINER does not widen what a user can start.
REVOKE ALL ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_workflow_run_step_job(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_workflow_run_step_jobs(integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_workflow_run_step_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_workflow_run_step_job(uuid, text, boolean, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_workflow_run_step_job(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_workflow_run_step_jobs(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_workflow_run_step_jobs(integer, integer) TO service_role;

-- Security fix for start_workflow_canvas_run, added in 20260808160000.
--
-- The function is SECURITY DEFINER and granted to `authenticated` (the run
-- route executes it on the caller's client), but it took the acting user as a
-- parameter and only checked that the canvas belonged to *that* parameter. A
-- signed-in caller could therefore pass a victim's user id together with the
-- victim's canvas id, and the ownership check would pass -- because the canvas
-- genuinely does belong to the id supplied.
--
-- On its own that inserted an orphan run row. It became a credit-theft vector
-- in combination with the durable queue landed in the same migration: the
-- caller also controls p_graph_snapshot, the forged run is created as
-- 'processing' with no live job, adoptStalledWorkflowRuns picks it up, and the
-- worker calls advanceWorkflowRunOnce -- which executes the nodes as
-- run.user_id and charges the victim.
--
-- The guard: when a request carries an end-user JWT, auth.uid() is the only
-- acceptable acting user. service_role callers (the cron worker and ops paths)
-- have no auth.uid() and keep passing it explicitly.

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
  v_caller uuid;
  v_key text;
  v_run public.workflow_canvas_runs%ROWTYPE;
BEGIN
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

  -- NULL for service_role; the acting user for anyone holding a user JWT.
  v_caller := auth.uid();
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'cannot start a workflow run for another user';
  END IF;

  IF btrim(coalesce(p_start_node_id, '')) = '' THEN
    RAISE EXCEPTION 'start_node_id is required';
  END IF;

  IF coalesce(p_mode, '') NOT IN ('node', 'branch') THEN
    RAISE EXCEPTION 'mode must be node or branch';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so ownership is re-checked here rather than
  -- trusted from the caller. With the guard above, p_user_id can no longer be
  -- an arbitrary third party.
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

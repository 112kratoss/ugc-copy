-- F12 follow-up: the new workflow creation boundary requires a stable request
-- identity and atomically creates its durable ownership. The older run-only RPC
-- remains keyless-compatible for one schema-first release window because the
-- previous app version is still serving while migrations apply. The new route
-- never calls it; revoke/drop it in the following release.

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

  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_canvases
    WHERE id = p_canvas_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'workflow canvas not found for this user';
  END IF;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  IF length(v_key) > 200 THEN
    RAISE EXCEPTION 'idempotency_key is too long';
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

  SELECT * INTO v_run
  FROM public.workflow_canvas_runs
  WHERE canvas_id = p_canvas_id AND idempotency_key = v_key;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'idempotent workflow run lookup failed for key %', v_key;
  END IF;

  RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, true;
END;
$$;

-- Keep the older start_workflow_canvas_run grant for one release only. The
-- production release applies migrations before promoting the new Vercel build,
-- so revoking it here would break the still-serving previous route during that
-- window. The new route never calls it; revoke/drop it in the next release once
-- production is confirmed on initialize_workflow_canvas_run.

-- One durable ownership handoff. The previous path inserted the run, executed
-- provider work, inserted steps one by one, updated the run, and only then
-- enqueued recovery. A function death at any seam could strand paid work or
-- leave an empty step set that looked successful. New callers use this RPC.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_canvas_run_steps_run_node_idx
  ON public.workflow_canvas_run_steps (run_id, node_id);

CREATE OR REPLACE FUNCTION public.initialize_workflow_canvas_run(
  p_canvas_id uuid,
  p_user_id uuid,
  p_start_node_id text,
  p_mode text,
  p_catalog_revision text,
  p_graph_snapshot jsonb,
  p_idempotency_key text,
  p_step_skeleton jsonb
)
RETURNS TABLE (
  run_id uuid,
  run_status text,
  run_created_at timestamptz,
  job_id uuid,
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
  v_job_id uuid;
BEGIN
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

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
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_canvases
    WHERE id = p_canvas_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'workflow canvas not found for this user';
  END IF;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  IF v_key IS NULL THEN RAISE EXCEPTION 'idempotency_key is required'; END IF;
  IF length(v_key) > 200 THEN RAISE EXCEPTION 'idempotency_key is too long'; END IF;

  IF jsonb_typeof(p_step_skeleton) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'step_skeleton must be an array';
  END IF;
  IF jsonb_array_length(p_step_skeleton) < 1
    OR jsonb_array_length(p_step_skeleton) > 200 THEN
    RAISE EXCEPTION 'step_skeleton must contain between 1 and 200 nodes';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_step_skeleton) AS item
    WHERE btrim(coalesce(item->>'nodeId', '')) = ''
  ) THEN
    RAISE EXCEPTION 'step_skeleton contains a blank node id';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(p_step_skeleton)
  ) IS DISTINCT FROM (
    SELECT count(DISTINCT item->>'nodeId') FROM jsonb_array_elements(p_step_skeleton) AS item
  ) THEN
    RAISE EXCEPTION 'step_skeleton contains duplicate node ids';
  END IF;

  INSERT INTO public.workflow_canvas_runs (
    canvas_id, user_id, start_node_id, mode, status,
    catalog_revision, graph_snapshot, idempotency_key
  ) VALUES (
    p_canvas_id, p_user_id, btrim(p_start_node_id), p_mode, 'processing',
    p_catalog_revision, p_graph_snapshot, v_key
  )
  ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_run;

  IF v_run.id IS NULL THEN
    SELECT * INTO v_run
    FROM public.workflow_canvas_runs
    WHERE canvas_id = p_canvas_id AND idempotency_key = v_key;

    IF v_run.id IS NULL THEN
      RAISE EXCEPTION 'idempotent workflow run lookup failed for key %', v_key;
    END IF;

    SELECT jobs.id INTO v_job_id
    FROM public.workflow_run_step_jobs AS jobs
    WHERE jobs.run_id = v_run.id
    ORDER BY jobs.attempt ASC
    LIMIT 1;

    RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, v_job_id, true;
    RETURN;
  END IF;

  INSERT INTO public.workflow_canvas_run_steps (
    run_id, node_id, status, input_snapshot, started_at, finished_at
  )
  SELECT
    v_run.id,
    btrim(item->>'nodeId'),
    'queued',
    CASE WHEN jsonb_typeof(item->'inputSnapshot') = 'object'
      THEN item->'inputSnapshot' ELSE NULL END,
    NULL,
    NULL
  FROM jsonb_array_elements(p_step_skeleton) AS item;

  INSERT INTO public.workflow_run_step_jobs (
    run_id, canvas_id, node_id, attempt, status, next_attempt_at, updated_at
  ) VALUES (
    v_run.id, p_canvas_id, btrim(p_start_node_id), 1, 'pending', now(), now()
  )
  RETURNING id INTO v_job_id;

  RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, v_job_id, false;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) TO authenticated, service_role;

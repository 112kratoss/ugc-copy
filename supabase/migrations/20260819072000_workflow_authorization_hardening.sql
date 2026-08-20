-- Additive workflow authorization hardening.
--
-- Migrations are applied before the application deployment is promoted. The
-- previous application still calls start_workflow_canvas_run and invokes the
-- atomic initializer with the caller's authenticated client during that skew
-- window, so this migration intentionally preserves those grants and the
-- owner-scoped table write policies. The stage-3 contraction is kept in
-- supabase/contract_migrations/security_remediation_stage3.sql and is promoted
-- only after cutover telemetry confirms there are no legacy callers.
--
-- While compatibility remains, enforce the application's existing admission
-- limit inside the legacy SECURITY DEFINER boundary itself. A caller therefore
-- cannot bypass 20 starts per ten minutes by calling the Data API directly.

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
  v_admission jsonb;
BEGIN
  IF p_canvas_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'canvas_id and user_id are required';
  END IF;

  v_caller := auth.uid();
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'cannot start a workflow run for another user';
  END IF;

  -- check_backend_rate_limit is service-only, but this SECURITY DEFINER
  -- function executes as its owner. The subject is safe because an end-user
  -- caller has already been bound to auth.uid() above.
  v_admission := public.check_backend_rate_limit(
    'legacy-workflow-run-start',
    p_user_id::text,
    20,
    600
  );
  IF NOT coalesce((v_admission->>'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'legacy workflow run rate limit exceeded';
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
  ) VALUES (
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

-- Pin the compatibility privileges explicitly rather than relying on CREATE OR
-- REPLACE to preserve whatever a target environment happened to have. Both
-- RPCs remain available to the old authenticated app, never to anonymous
-- callers, until the deferred contraction makes the initializer service-only
-- and drops the legacy starter.
REVOKE ALL ON FUNCTION public.start_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.initialize_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text, jsonb
) TO authenticated, service_role;

COMMENT ON FUNCTION public.start_workflow_canvas_run(
  uuid, uuid, text, text, text, jsonb, text
) IS
  'Compatibility-only workflow starter, owner-bound and internally limited to 20 calls per user per ten minutes. Remove through the deferred stage-3 contract migration.';

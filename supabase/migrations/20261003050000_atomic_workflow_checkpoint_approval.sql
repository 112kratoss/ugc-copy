-- A checkpoint, its resumed run and the durable wake ticket are one action.
-- Otherwise a failed run update can leave an approved gate stranded forever.
CREATE OR REPLACE FUNCTION public.approve_workflow_checkpoint(
  p_canvas_id uuid,
  p_run_id uuid,
  p_step_id uuid,
  p_user_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_run public.workflow_canvas_runs%ROWTYPE;
  v_step public.workflow_canvas_run_steps%ROWTYPE;
  v_graph jsonb;
  v_pending_output text;
BEGIN
  SELECT * INTO v_run FROM public.workflow_canvas_runs
    WHERE id = p_run_id AND canvas_id = p_canvas_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'RUN_NOT_FOUND'; END IF;
  IF v_run.status NOT IN ('processing', 'awaiting_approval') THEN RETURN 'RUN_TERMINAL'; END IF;

  SELECT * INTO v_step FROM public.workflow_canvas_run_steps
    WHERE id = p_step_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STEP_NOT_FOUND'; END IF;
  IF v_step.status <> 'awaiting_approval' THEN RETURN 'STEP_NOT_AWAITING'; END IF;

  v_graph := v_run.graph_snapshot;
  IF v_graph IS NULL THEN
    SELECT graph INTO v_graph FROM public.workflow_canvases
      WHERE id = p_canvas_id AND user_id = p_user_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_graph -> 'nodes', '[]'::jsonb)) AS node
                 WHERE node ->> 'id' = v_step.node_id AND node ->> 'type' = 'approval-gate') THEN
    RETURN 'NOT_APPROVAL_STEP';
  END IF;
  IF jsonb_typeof(v_step.output_snapshot -> 'pendingOutputUrl') IS DISTINCT FROM 'string' THEN
    RETURN 'PREVIEW_UNAVAILABLE';
  END IF;
  v_pending_output := v_step.output_snapshot ->> 'pendingOutputUrl';
  IF btrim(v_pending_output) = '' THEN RETURN 'PREVIEW_UNAVAILABLE'; END IF;

  UPDATE public.workflow_canvas_run_steps
    SET status = 'succeeded',
        output_snapshot = v_step.output_snapshot || jsonb_build_object(
          'outputUrl', v_pending_output, 'approvedAt', now()),
        error_message = NULL, finished_at = now()
    WHERE id = v_step.id AND run_id = p_run_id;
  UPDATE public.workflow_canvas_runs SET status = 'processing', finished_at = NULL
    WHERE id = p_run_id;
  PERFORM public.enqueue_workflow_run_step_job(p_run_id, 'approval:' || v_step.node_id, 1);
  RETURN 'approved';
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_workflow_checkpoint(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_workflow_checkpoint(uuid, uuid, uuid, uuid) TO service_role;

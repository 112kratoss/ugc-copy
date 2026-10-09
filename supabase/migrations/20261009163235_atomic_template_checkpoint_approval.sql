-- Approving a checkpoint must not commit without durable execution of the run.
-- Use the same run-before-step lock order as checkpoint retry.
CREATE OR REPLACE FUNCTION public.approve_template_checkpoint(
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
  v_run public.template_runs%ROWTYPE;
  v_step public.template_run_steps%ROWTYPE;
BEGIN
  SELECT * INTO v_run FROM public.template_runs
    WHERE id = p_run_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'RUN_NOT_FOUND'; END IF;
  IF v_run.status IN ('succeeded', 'failed', 'cancelled') THEN RETURN 'RUN_TERMINAL'; END IF;

  SELECT * INTO v_step FROM public.template_run_steps
    WHERE id = p_step_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STEP_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM public.template_run_steps
      WHERE run_id = p_run_id AND node_id = v_step.node_id AND attempt > v_step.attempt) THEN
    RETURN 'STALE_STEP_ATTEMPT';
  END IF;
  IF v_step.kind <> 'approval' OR v_step.status <> 'awaiting_approval'
      OR coalesce(v_step.output_url, '') = '' THEN
    RETURN 'APPROVAL_NOT_READY';
  END IF;

  UPDATE public.template_run_steps
    SET status = 'succeeded', approved_at = now(), finished_at = now(), error_message = NULL
    WHERE id = v_step.id;
  UPDATE public.template_runs SET status = 'processing', error_message = NULL
    WHERE id = v_run.id;
  PERFORM public.enqueue_template_run_job(v_run.id);
  RETURN 'approved';
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_template_checkpoint(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_template_checkpoint(uuid, uuid, uuid) TO service_role;

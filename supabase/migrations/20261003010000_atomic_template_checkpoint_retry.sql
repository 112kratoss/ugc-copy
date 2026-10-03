-- Reserve a checkpoint retry and both next attempts in one transaction. A
-- concurrent approval/cancellation must win or lose before new work is queued.
CREATE OR REPLACE FUNCTION public.retry_template_checkpoint(
  p_run_id uuid,
  p_step_id uuid,
  p_source_step_id uuid,
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
  v_source public.template_run_steps%ROWTYPE;
  v_latest_attempt integer;
BEGIN
  SELECT * INTO v_run FROM public.template_runs
    WHERE id = p_run_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'RUN_NOT_FOUND'; END IF;
  IF v_run.status IN ('succeeded', 'failed', 'cancelled') THEN RETURN 'RUN_TERMINAL'; END IF;

  SELECT * INTO v_step FROM public.template_run_steps
    WHERE id = p_step_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'STEP_NOT_FOUND'; END IF;
  SELECT max(attempt) INTO v_latest_attempt FROM public.template_run_steps
    WHERE run_id = p_run_id AND node_id = v_step.node_id;
  IF v_latest_attempt = v_step.attempt + 1 THEN RETURN 'existing'; END IF;
  IF v_latest_attempt <> v_step.attempt THEN RETURN 'STALE_STEP_ATTEMPT'; END IF;
  IF v_step.kind <> 'approval' OR NOT v_step.can_retry OR v_step.status <> 'awaiting_approval' THEN
    RETURN 'STEP_NOT_RETRYABLE';
  END IF;

  SELECT * INTO v_source FROM public.template_run_steps
    WHERE id = p_source_step_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'UPSTREAM_STEP_NOT_RETRYABLE'; END IF;
  IF v_source.kind <> 'generation' OR v_source.status <> 'succeeded'
     OR EXISTS (SELECT 1 FROM public.template_run_steps
                WHERE run_id = p_run_id AND node_id = v_source.node_id AND attempt > v_source.attempt) THEN
    RETURN 'UPSTREAM_STEP_NOT_RETRYABLE';
  END IF;

  UPDATE public.template_run_steps SET status = 'cancelled', finished_at = now()
    WHERE id = v_step.id;
  INSERT INTO public.template_run_steps
    (run_id, node_id, attempt, kind, media_kind, label, status, can_retry, estimated_credits)
  VALUES
    (v_source.run_id, v_source.node_id, v_source.attempt + 1, v_source.kind,
     v_source.media_kind, v_source.label, 'queued', v_source.can_retry, v_source.estimated_credits),
    (v_step.run_id, v_step.node_id, v_step.attempt + 1, v_step.kind,
     v_step.media_kind, v_step.label, 'queued', v_step.can_retry, v_step.estimated_credits);
  UPDATE public.template_runs SET status = 'queued', error_message = NULL
    WHERE id = p_run_id AND status IN ('awaiting_approval', 'needs_attention');
  PERFORM public.enqueue_template_run_job(p_run_id);
  RETURN 'retried';
END;
$function$;

REVOKE ALL ON FUNCTION public.retry_template_checkpoint(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_template_checkpoint(uuid, uuid, uuid, uuid) TO service_role;

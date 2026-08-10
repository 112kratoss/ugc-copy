-- Workflow execution is durable, but its recovery cron is intentionally slow.
-- Wake the exact deferred run when a linked generation becomes terminal so
-- production does not depend on a browser poll or a 10-minute scheduler tick.

CREATE OR REPLACE FUNCTION public.wake_workflow_run_step_job(p_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.workflow_canvas_runs%ROWTYPE;
  v_job_id uuid;
  v_highest_attempt integer;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'run_id is required';
  END IF;

  -- Serialize terminal callbacks, adoption and retry creation for this run.
  SELECT * INTO v_run
  FROM public.workflow_canvas_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF v_run.id IS NULL OR v_run.status <> 'processing' THEN
    RETURN NULL;
  END IF;

  -- A live worker already owns progress. It will either observe the terminal
  -- generation in this pass or defer for at most 60 seconds.
  SELECT id INTO v_job_id
  FROM public.workflow_run_step_jobs
  WHERE run_id = p_run_id AND status = 'processing'
  ORDER BY attempt DESC
  LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  -- Accelerate the existing deferred ticket without changing its attempt.
  UPDATE public.workflow_run_step_jobs
  SET next_attempt_at = least(next_attempt_at, now()),
      updated_at = now()
  WHERE id = (
    SELECT id
    FROM public.workflow_run_step_jobs
    WHERE run_id = p_run_id AND status = 'pending'
    ORDER BY attempt DESC
    LIMIT 1
    FOR UPDATE
  )
  RETURNING id INTO v_job_id;

  IF v_job_id IS NOT NULL THEN
    RETURN v_job_id;
  END IF;

  -- If a worker died after finishing its ticket but before advancing the run,
  -- create the next bounded attempt. Never bypass the queue's retry ceiling.
  SELECT coalesce(max(attempt), 0) INTO v_highest_attempt
  FROM public.workflow_run_step_jobs
  WHERE run_id = p_run_id;

  IF v_highest_attempt >= 5 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.workflow_run_step_jobs (
    run_id, canvas_id, node_id, attempt, status, next_attempt_at, updated_at
  )
  VALUES (
    v_run.id,
    v_run.canvas_id,
    v_run.start_node_id,
    v_highest_attempt + 1,
    'pending',
    now(),
    now()
  )
  ON CONFLICT ON CONSTRAINT workflow_run_step_jobs_run_node_attempt_key
  DO UPDATE SET
    next_attempt_at = least(public.workflow_run_step_jobs.next_attempt_at, excluded.next_attempt_at),
    updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wake_workflow_runs_after_generation_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run_id uuid;
BEGIN
  IF NEW.status NOT IN ('succeeded', 'failed')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  FOR v_run_id IN
    SELECT DISTINCT steps.run_id
    FROM public.workflow_canvas_run_steps AS steps
    WHERE steps.generation_id = NEW.id
  LOOP
    PERFORM public.wake_workflow_run_step_job(v_run_id);
  END LOOP;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS generations_wake_workflow_runs_after_terminal
  ON public.generations;
CREATE TRIGGER generations_wake_workflow_runs_after_terminal
AFTER UPDATE OF status ON public.generations
FOR EACH ROW
WHEN (
  NEW.status IN ('succeeded', 'failed')
  AND NEW.status IS DISTINCT FROM OLD.status
)
EXECUTE FUNCTION public.wake_workflow_runs_after_generation_terminal();

REVOKE ALL ON FUNCTION public.wake_workflow_run_step_job(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_workflow_run_step_job(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_workflow_run_step_job(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.wake_workflow_runs_after_generation_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_workflow_runs_after_generation_terminal() FROM anon, authenticated;

COMMENT ON FUNCTION public.wake_workflow_run_step_job(uuid) IS
  'Makes the durable ticket for a processing workflow run immediately due without stealing a live lease or bypassing the five-attempt ceiling.';

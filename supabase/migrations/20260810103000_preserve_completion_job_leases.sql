-- A provider may retry the same callback while the first delivery is still
-- importing a large output. Re-enqueueing must not revoke the live worker's
-- lease or make the job concurrently claimable.

CREATE OR REPLACE FUNCTION public.enqueue_generation_completion_job(
  p_prediction_id text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job_id uuid;
BEGIN
  IF btrim(coalesce(p_prediction_id, '')) = '' THEN
    RAISE EXCEPTION 'prediction_id is required';
  END IF;

  INSERT INTO public.generation_completion_jobs (
    prediction_id,
    payload,
    status,
    next_attempt_at,
    locked_at,
    locked_by,
    last_error,
    updated_at,
    completed_at
  )
  VALUES (
    btrim(p_prediction_id),
    coalesce(p_payload, '{}'::jsonb),
    'pending',
    now(),
    NULL,
    NULL,
    NULL,
    now(),
    NULL
  )
  ON CONFLICT (prediction_id) DO UPDATE
    SET payload = excluded.payload,
        -- Duplicate delivery is new evidence for a pending job, so it may make
        -- that job due now. Processing and terminal rows retain their exact
        -- state; requeueing those requires an explicit recovery decision.
        next_attempt_at = CASE
          WHEN public.generation_completion_jobs.status = 'pending'
            THEN least(public.generation_completion_jobs.next_attempt_at, now())
          ELSE public.generation_completion_jobs.next_attempt_at
        END,
        locked_at = public.generation_completion_jobs.locked_at,
        locked_by = public.generation_completion_jobs.locked_by,
        last_error = CASE
          WHEN public.generation_completion_jobs.status = 'pending' THEN NULL
          ELSE public.generation_completion_jobs.last_error
        END,
        completed_at = public.generation_completion_jobs.completed_at,
        updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) TO service_role;

COMMENT ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) IS
  'Idempotently enqueues provider completion. Duplicate callbacks preserve processing leases and terminal state; only a pending row is accelerated.';

-- Record whether a generation completion finished on the inline post-webhook
-- drain or on the 10-minute cron sweep.
--
-- Why this cannot be derived from existing data: `finish_generation_completion_job`
-- sets `locked_by = NULL` when it settles a job, so the identity of the runner
-- that completed it is destroyed at exactly the moment it becomes interesting.
-- Production confirms this — every completed job has a NULL `locked_by`.
--
-- Why the function signature is left alone: the RPC already receives
-- `p_locked_by`, and the two callers already write distinguishable owners —
-- `kie-webhook:{predictionId}:{ms}` for the inline drain and
-- `{jobName}:{requestId}:{ms}` for the cron sweep. So the source can be derived
-- inside the same UPDATE that already runs. No new parameter, no caller change,
-- no new failure mode on a path that settles paid generations.
--
-- This measurement is the prerequisite for the durable-queue decision: without
-- knowing what share of completions the inline drain already absorbs, any
-- threshold for graduating to pgmq would be guesswork.

ALTER TABLE public.generation_completion_jobs
  ADD COLUMN IF NOT EXISTS completed_via text;

COMMENT ON COLUMN public.generation_completion_jobs.completed_via IS
  'Which runner settled this job: webhook_drain (inline, immediately after the provider callback) or cron_sweep (the 10-minute backend job). NULL for jobs that have not reached a terminal state, and for jobs completed before this column existed. Derived from the lock owner inside finish_generation_completion_job; never set by callers.';

ALTER TABLE public.generation_completion_jobs
  DROP CONSTRAINT IF EXISTS generation_completion_jobs_completed_via_check;
ALTER TABLE public.generation_completion_jobs
  ADD CONSTRAINT generation_completion_jobs_completed_via_check
  CHECK (completed_via IS NULL OR completed_via IN ('webhook_drain', 'cron_sweep'));

-- Recreated verbatim apart from the completed_via assignment, so the settlement
-- semantics this function guards are untouched.
CREATE OR REPLACE FUNCTION public.finish_generation_completion_job(
  p_id uuid,
  p_locked_by text,
  p_succeeded boolean,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60
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

  IF p_retry_delay_seconds < 1 THEN
    RAISE EXCEPTION 'retry delay must be positive';
  END IF;

  UPDATE public.generation_completion_jobs
  SET status = CASE
        WHEN p_succeeded THEN 'succeeded'
        WHEN attempt_count >= 5 THEN 'failed'
        ELSE 'pending'
      END,
      next_attempt_at = CASE
        WHEN p_succeeded OR attempt_count >= 5 THEN now()
        ELSE now() + make_interval(secs => p_retry_delay_seconds)
      END,
      locked_at = NULL,
      locked_by = NULL,
      last_error = CASE WHEN p_succeeded THEN NULL ELSE left(coalesce(p_error, 'Unknown error'), 2000) END,
      completed_at = CASE WHEN p_succeeded OR attempt_count >= 5 THEN now() ELSE NULL END,
      -- Only stamped on a terminal transition. A job that goes back to
      -- 'pending' for another attempt keeps whatever it had, so a retry that
      -- later succeeds on the cron sweep is attributed to the cron sweep.
      completed_via = CASE
        WHEN p_succeeded OR attempt_count >= 5
          THEN CASE
            WHEN p_locked_by LIKE 'kie-webhook:%' THEN 'webhook_drain'
            ELSE 'cron_sweep'
          END
        ELSE completed_via
      END,
      updated_at = now()
  WHERE id = p_id
    AND status = 'processing'
    AND locked_by = p_locked_by
  RETURNING status INTO v_status;

  IF v_status IS NOT NULL THEN
    RETURN v_status;
  END IF;

  SELECT status INTO v_status
  FROM public.generation_completion_jobs
  WHERE id = p_id;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) TO service_role;

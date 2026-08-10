-- Template runs previously advanced only from GET polling. A closed tab or a
-- recycled function stranded paid work, while multiple tabs could race the
-- same step. Give each run one durable leased execution ticket and wake it on
-- run-state or linked-generation transitions.

CREATE TABLE IF NOT EXISTS public.template_run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL UNIQUE REFERENCES public.template_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT template_run_jobs_lock_pair_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL AND btrim(locked_by) <> '')
  )
);

CREATE INDEX IF NOT EXISTS template_run_jobs_due_idx
  ON public.template_run_jobs (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS template_run_jobs_updated_idx
  ON public.template_run_jobs (updated_at);
CREATE INDEX IF NOT EXISTS template_run_jobs_user_idx
  ON public.template_run_jobs (user_id);

ALTER TABLE public.template_run_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.template_run_jobs FROM PUBLIC;
REVOKE ALL ON public.template_run_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.template_run_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_template_run_job(p_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_run public.template_runs%ROWTYPE;
  v_job_id uuid;
BEGIN
  SELECT * INTO v_run
  FROM public.template_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'template run % not found', p_run_id;
  END IF;

  IF v_run.status NOT IN ('queued', 'processing') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.template_run_jobs (
    run_id, user_id, status, attempt_count, next_attempt_at, updated_at
  )
  VALUES (v_run.id, v_run.user_id, 'pending', 0, now(), now())
  ON CONFLICT (run_id) DO UPDATE SET
    -- Never revoke a live lease. Its worker will observe the newly committed
    -- state or defer briefly; a second owner would duplicate paid starts.
    status = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN 'processing'
      ELSE 'pending'
    END,
    attempt_count = CASE
      WHEN public.template_run_jobs.status IN ('failed', 'cancelled', 'succeeded') THEN 0
      ELSE public.template_run_jobs.attempt_count
    END,
    next_attempt_at = CASE
      WHEN public.template_run_jobs.status = 'processing'
        THEN public.template_run_jobs.next_attempt_at
      ELSE least(public.template_run_jobs.next_attempt_at, now())
    END,
    locked_at = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN public.template_run_jobs.locked_at
      ELSE NULL
    END,
    locked_by = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN public.template_run_jobs.locked_by
      ELSE NULL
    END,
    heartbeat_at = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN public.template_run_jobs.heartbeat_at
      ELSE NULL
    END,
    last_error = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN public.template_run_jobs.last_error
      ELSE NULL
    END,
    completed_at = CASE
      WHEN public.template_run_jobs.status = 'processing' THEN public.template_run_jobs.completed_at
      ELSE NULL
    END,
    updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_template_run_jobs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS SETOF public.template_run_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;
  IF p_lock_ttl_seconds < 1 THEN
    RAISE EXCEPTION 'lock ttl must be positive';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT jobs.id
    FROM public.template_run_jobs AS jobs
    JOIN public.template_runs AS runs ON runs.id = jobs.run_id
    WHERE runs.status IN ('queued', 'processing')
      AND (
        (jobs.status = 'pending' AND jobs.next_attempt_at <= now())
        OR (
          jobs.status = 'processing'
          AND coalesce(jobs.heartbeat_at, jobs.locked_at)
            <= now() - make_interval(secs => p_lock_ttl_seconds)
        )
      )
    ORDER BY jobs.next_attempt_at, jobs.created_at
    LIMIT least(greatest(coalesce(p_limit, 1), 1), 25)
    FOR UPDATE OF jobs SKIP LOCKED
  )
  UPDATE public.template_run_jobs AS jobs
  SET status = 'processing',
      locked_at = now(),
      locked_by = p_locked_by,
      heartbeat_at = now(),
      updated_at = now()
  FROM candidates
  WHERE jobs.id = candidates.id
  RETURNING jobs.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_template_run_job(
  p_id uuid,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.template_run_jobs
  SET heartbeat_at = now(), updated_at = now()
  WHERE id = p_id AND status = 'processing' AND locked_by = p_locked_by;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.defer_template_run_job(
  p_id uuid,
  p_locked_by text,
  p_delay_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.template_run_jobs
  SET status = 'pending',
      next_attempt_at = now() + make_interval(secs => greatest(p_delay_seconds, 1)),
      locked_at = NULL,
      locked_by = NULL,
      heartbeat_at = NULL,
      updated_at = now()
  WHERE id = p_id AND status = 'processing' AND locked_by = p_locked_by;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_template_run_job(
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
AS $function$
DECLARE
  v_job public.template_run_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.template_run_jobs
  WHERE id = p_id AND status = 'processing' AND locked_by = p_locked_by
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RETURN (SELECT status FROM public.template_run_jobs WHERE id = p_id);
  END IF;

  IF p_succeeded THEN
    UPDATE public.template_run_jobs
    SET status = 'succeeded',
        locked_at = NULL, locked_by = NULL, heartbeat_at = NULL,
        last_error = NULL, completed_at = now(), updated_at = now()
    WHERE id = p_id;
    RETURN 'succeeded';
  END IF;

  IF v_job.attempt_count + 1 < greatest(p_max_attempts, 1) THEN
    UPDATE public.template_run_jobs
    SET status = 'pending',
        attempt_count = attempt_count + 1,
        next_attempt_at = now() + make_interval(secs => greatest(p_retry_delay_seconds, 1)),
        locked_at = NULL, locked_by = NULL, heartbeat_at = NULL,
        last_error = left(coalesce(p_error, 'Unknown error'), 2000),
        updated_at = now()
    WHERE id = p_id;
    RETURN 'retry_scheduled';
  END IF;

  UPDATE public.template_run_jobs
  SET status = 'failed',
      attempt_count = attempt_count + 1,
      locked_at = NULL, locked_by = NULL, heartbeat_at = NULL,
      last_error = left(coalesce(p_error, 'Unknown error'), 2000),
      completed_at = now(), updated_at = now()
  WHERE id = p_id;
  RETURN 'exhausted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_due_template_run_jobs(
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.template_run_jobs AS jobs
    JOIN public.template_runs AS runs ON runs.id = jobs.run_id
    WHERE runs.status IN ('queued', 'processing')
      AND (
        (jobs.status = 'pending' AND jobs.next_attempt_at <= now())
        OR (
          jobs.status = 'processing'
          AND coalesce(jobs.heartbeat_at, jobs.locked_at)
            <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1))
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.prune_template_run_jobs(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT id
    FROM public.template_run_jobs
    WHERE status IN ('succeeded', 'failed', 'cancelled')
      AND updated_at < now() - make_interval(days => greatest(p_retention_days, 1))
    ORDER BY updated_at
    LIMIT least(greatest(p_limit, 1), 5000)
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.template_run_jobs AS jobs
  USING victims
  WHERE jobs.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_template_run_after_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.status IN ('queued', 'processing')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.enqueue_template_run_job(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS template_runs_enqueue_after_state_change ON public.template_runs;
CREATE TRIGGER template_runs_enqueue_after_state_change
AFTER UPDATE OF status ON public.template_runs
FOR EACH ROW
WHEN (
  NEW.status IN ('queued', 'processing')
  AND NEW.status IS DISTINCT FROM OLD.status
)
EXECUTE FUNCTION public.enqueue_template_run_after_state_change();

CREATE OR REPLACE FUNCTION public.enqueue_template_run_after_generation_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.template_run_id IS NOT NULL
     AND NEW.status IN ('succeeded', 'failed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.enqueue_template_run_job(NEW.template_run_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS generations_enqueue_template_run_after_terminal ON public.generations;
CREATE TRIGGER generations_enqueue_template_run_after_terminal
AFTER UPDATE OF status ON public.generations
FOR EACH ROW
WHEN (
  NEW.template_run_id IS NOT NULL
  AND NEW.status IN ('succeeded', 'failed')
  AND NEW.status IS DISTINCT FROM OLD.status
)
EXECUTE FUNCTION public.enqueue_template_run_after_generation_terminal();

REVOKE ALL ON FUNCTION public.enqueue_template_run_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_template_run_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_template_run_job(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.defer_template_run_job(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_template_run_job(uuid, text, boolean, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_due_template_run_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_template_run_jobs(integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_template_run_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_template_run_jobs(integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_template_run_job(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.defer_template_run_job(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_template_run_job(uuid, text, boolean, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_due_template_run_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_template_run_jobs(integer, integer) TO service_role;

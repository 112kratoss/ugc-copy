-- Provider success and durable media persistence are separate failure domains.
-- Store the provider URLs in a leased queue so Storage/ffmpeg work never has
-- to complete inside a webhook or status GET, and can retry without refunding
-- provider-completed work.

CREATE TABLE IF NOT EXISTS public.generation_output_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL UNIQUE REFERENCES public.generations(id) ON DELETE CASCADE,
  prediction_id text NOT NULL,
  output_urls jsonb NOT NULL CHECK (
    jsonb_typeof(output_urls) = 'array'
    AND jsonb_array_length(output_urls) BETWEEN 1 AND 8
  ),
  provider_completed_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT generation_output_import_jobs_lock_pair_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL AND btrim(locked_by) <> '')
  )
);

CREATE INDEX IF NOT EXISTS generation_output_import_jobs_due_idx
  ON public.generation_output_import_jobs (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS generation_output_import_jobs_updated_idx
  ON public.generation_output_import_jobs (updated_at);

ALTER TABLE public.generation_output_import_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_output_import_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_output_import_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_generation_output_import_job(
  p_generation_id uuid,
  p_output_urls jsonb,
  p_provider_completed_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prediction_id text;
  v_job_id uuid;
BEGIN
  IF jsonb_typeof(p_output_urls) <> 'array'
     OR jsonb_array_length(p_output_urls) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_output_urls) AS item
       WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
     ) THEN
    RAISE EXCEPTION 'output_urls must contain between 1 and 8 non-empty strings';
  END IF;

  SELECT prediction_id INTO v_prediction_id
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF v_prediction_id IS NULL THEN
    RAISE EXCEPTION 'generation % has no provider task id', p_generation_id;
  END IF;

  INSERT INTO public.generation_output_import_jobs (
    generation_id, prediction_id, output_urls, provider_completed_at,
    status, next_attempt_at, updated_at
  )
  VALUES (
    p_generation_id, v_prediction_id, p_output_urls, p_provider_completed_at,
    'pending', now(), now()
  )
  ON CONFLICT (generation_id) DO UPDATE SET
    -- A duplicate callback may refresh identical payload data, but it cannot
    -- revoke a live worker or reopen a successfully persisted output.
    output_urls = CASE
      WHEN public.generation_output_import_jobs.status = 'succeeded'
        THEN public.generation_output_import_jobs.output_urls
      ELSE excluded.output_urls
    END,
    provider_completed_at = coalesce(
      public.generation_output_import_jobs.provider_completed_at,
      excluded.provider_completed_at
    ),
    status = CASE
      WHEN public.generation_output_import_jobs.status IN ('processing', 'succeeded')
        THEN public.generation_output_import_jobs.status
      ELSE 'pending'
    END,
    next_attempt_at = CASE
      WHEN public.generation_output_import_jobs.status IN ('processing', 'succeeded')
        THEN public.generation_output_import_jobs.next_attempt_at
      ELSE least(public.generation_output_import_jobs.next_attempt_at, now())
    END,
    locked_at = CASE
      WHEN public.generation_output_import_jobs.status = 'processing'
        THEN public.generation_output_import_jobs.locked_at
      ELSE NULL
    END,
    locked_by = CASE
      WHEN public.generation_output_import_jobs.status = 'processing'
        THEN public.generation_output_import_jobs.locked_by
      ELSE NULL
    END,
    updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_generation_output_import_jobs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS SETOF public.generation_output_import_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.generation_output_import_jobs
    WHERE (status = 'pending' AND next_attempt_at <= now())
       OR (status = 'processing' AND locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
    ORDER BY next_attempt_at, created_at
    LIMIT least(greatest(p_limit, 1), 25)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_output_import_jobs AS jobs
  SET status = 'processing', locked_at = now(), locked_by = p_locked_by, updated_at = now()
  FROM candidates
  WHERE jobs.id = candidates.id
  RETURNING jobs.*;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_generation_output_import_job(
  p_id uuid,
  p_locked_by text,
  p_succeeded boolean,
  p_error text DEFAULT NULL,
  p_retry_delay_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 10
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job public.generation_output_import_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.generation_output_import_jobs
  WHERE id = p_id AND status = 'processing' AND locked_by = p_locked_by
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RETURN (SELECT status FROM public.generation_output_import_jobs WHERE id = p_id);
  END IF;

  IF p_succeeded THEN
    UPDATE public.generation_output_import_jobs
    SET status = 'succeeded', locked_at = NULL, locked_by = NULL,
        last_error = NULL, completed_at = now(), updated_at = now()
    WHERE id = p_id;
    RETURN 'succeeded';
  END IF;

  IF v_job.attempt_count + 1 < greatest(p_max_attempts, 1) THEN
    UPDATE public.generation_output_import_jobs
    SET status = 'pending', attempt_count = attempt_count + 1,
        next_attempt_at = now() + make_interval(secs => greatest(p_retry_delay_seconds, 1)),
        locked_at = NULL, locked_by = NULL,
        last_error = left(coalesce(p_error, 'Output import failed'), 2000), updated_at = now()
    WHERE id = p_id;
    RETURN 'retry_scheduled';
  END IF;

  UPDATE public.generation_output_import_jobs
  SET status = 'failed', attempt_count = attempt_count + 1,
      locked_at = NULL, locked_by = NULL,
      last_error = left(coalesce(p_error, 'Output import failed'), 2000),
      completed_at = now(), updated_at = now()
  WHERE id = p_id;
  RETURN 'exhausted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_due_generation_output_import_jobs(
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.generation_output_import_jobs
    WHERE (status = 'pending' AND next_attempt_at <= now())
       OR (status = 'processing' AND locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
  );
$function$;

REVOKE ALL ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_generation_output_import_job(uuid, text, boolean, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_due_generation_output_import_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_generation_output_import_job(uuid, text, boolean, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_due_generation_output_import_jobs(integer) TO service_role;

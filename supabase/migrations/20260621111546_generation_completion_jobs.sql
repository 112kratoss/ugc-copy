CREATE TABLE IF NOT EXISTS public.generation_completion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT generation_completion_jobs_prediction_id_not_blank CHECK (btrim(prediction_id) <> ''),
  CONSTRAINT generation_completion_jobs_status_check CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  CONSTRAINT generation_completion_jobs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT generation_completion_jobs_lock_pair_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL AND btrim(locked_by) <> '')
  )
);

CREATE INDEX IF NOT EXISTS generation_completion_jobs_pending_idx
  ON public.generation_completion_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS generation_completion_jobs_updated_idx
  ON public.generation_completion_jobs (updated_at);

ALTER TABLE public.generation_completion_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.generation_completion_jobs FROM PUBLIC;
REVOKE ALL ON public.generation_completion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_completion_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_generation_completion_job(
  p_prediction_id text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
        status = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.status
          ELSE 'pending'
        END,
        next_attempt_at = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.next_attempt_at
          ELSE now()
        END,
        locked_at = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.locked_at
          ELSE NULL
        END,
        locked_by = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.locked_by
          ELSE NULL
        END,
        last_error = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.last_error
          ELSE NULL
        END,
        completed_at = CASE
          WHEN public.generation_completion_jobs.status = 'succeeded'
            THEN public.generation_completion_jobs.completed_at
          ELSE NULL
        END,
        updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_generation_completion_jobs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300,
  p_prediction_id text DEFAULT NULL
)
RETURNS SETOF public.generation_completion_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN
    RAISE EXCEPTION 'locked_by is required';
  END IF;

  IF p_lock_ttl_seconds < 1 THEN
    RAISE EXCEPTION 'lock ttl must be positive';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.generation_completion_jobs
    WHERE (p_prediction_id IS NULL OR prediction_id = p_prediction_id)
      AND (
        (status = 'pending' AND next_attempt_at <= now())
        OR (
          status = 'processing'
          AND locked_at <= now() - make_interval(secs => p_lock_ttl_seconds)
        )
      )
    ORDER BY created_at ASC
    LIMIT least(greatest(coalesce(p_limit, 1), 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_completion_jobs
  SET status = 'processing',
      attempt_count = public.generation_completion_jobs.attempt_count + 1,
      locked_at = now(),
      locked_by = p_locked_by,
      updated_at = now()
  FROM candidates
  WHERE public.generation_completion_jobs.id = candidates.id
  RETURNING public.generation_completion_jobs.*;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.prune_generation_completion_jobs(
  p_retention_days integer DEFAULT 30,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_retention_days < 1 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'retention days must be between 1 and 3650';
  END IF;

  IF p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'prune limit must be between 1 and 10000';
  END IF;

  WITH deleted AS (
    DELETE FROM public.generation_completion_jobs
    WHERE id IN (
      SELECT id
      FROM public.generation_completion_jobs
      WHERE status IN ('succeeded', 'failed')
        AND updated_at < now() - make_interval(days => p_retention_days)
      ORDER BY updated_at ASC
      LIMIT p_limit
    )
    RETURNING id
  )
  SELECT count(*)::integer INTO v_deleted FROM deleted;

  RETURN coalesce(v_deleted, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_generation_completion_jobs(integer, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_generation_completion_jobs(integer, integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_generation_completion_jobs(integer, text, integer, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_generation_completion_jobs(integer, integer) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_generation_completion_jobs(integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_generation_completion_jobs(integer, integer) TO service_role;

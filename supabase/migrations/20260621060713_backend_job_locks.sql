CREATE TABLE IF NOT EXISTS public.backend_job_locks (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL,
  locked_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backend_job_locks_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT backend_job_locks_locked_by_not_blank CHECK (btrim(locked_by) <> '')
);

ALTER TABLE public.backend_job_locks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.backend_job_locks FROM PUBLIC;
REVOKE ALL ON public.backend_job_locks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_locks TO service_role;

CREATE OR REPLACE FUNCTION public.try_acquire_backend_job_lock(
  p_name text,
  p_ttl_seconds integer,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_locked_by text := btrim(coalesce(p_locked_by, ''));
  v_acquired boolean := false;
BEGIN
  IF v_name = '' THEN
    RAISE EXCEPTION 'Backend job lock name is required';
  END IF;

  IF v_locked_by = '' THEN
    RAISE EXCEPTION 'Backend job lock owner is required';
  END IF;

  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'Backend job lock TTL must be between 1 and 3600 seconds';
  END IF;

  INSERT INTO public.backend_job_locks (name, locked_until, locked_by, updated_at)
  VALUES (v_name, now() + make_interval(secs => p_ttl_seconds), v_locked_by, now())
  ON CONFLICT (name) DO UPDATE
    SET locked_until = excluded.locked_until,
        locked_by = excluded.locked_by,
        updated_at = now()
    WHERE public.backend_job_locks.locked_until <= now()
      OR public.backend_job_locks.locked_by = excluded.locked_by
  RETURNING true INTO v_acquired;

  RETURN coalesce(v_acquired, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_backend_job_lock(
  p_name text,
  p_locked_by text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(coalesce(p_name, ''));
  v_locked_by text := btrim(coalesce(p_locked_by, ''));
BEGIN
  IF v_name = '' OR v_locked_by = '' THEN
    RETURN false;
  END IF;

  DELETE FROM public.backend_job_locks
  WHERE name = v_name
    AND locked_by = v_locked_by;

  RETURN found;
END;
$$;

REVOKE ALL ON FUNCTION public.try_acquire_backend_job_lock(text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_backend_job_lock(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_acquire_backend_job_lock(text, integer, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.release_backend_job_lock(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_acquire_backend_job_lock(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_backend_job_lock(text, text) TO service_role;

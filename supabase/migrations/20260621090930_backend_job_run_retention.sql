CREATE INDEX IF NOT EXISTS backend_job_runs_started_idx
  ON public.backend_job_runs (started_at);

CREATE OR REPLACE FUNCTION public.prune_backend_job_runs(
  p_retention_days integer DEFAULT 45,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'Backend job run retention days must be between 1 and 3650';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Backend job run prune limit must be between 1 and 10000';
  END IF;

  WITH deleted AS (
    DELETE FROM public.backend_job_runs
    WHERE id IN (
      SELECT id
      FROM public.backend_job_runs
      WHERE started_at < now() - make_interval(days => p_retention_days)
      ORDER BY started_at ASC
      LIMIT p_limit
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted
  FROM deleted;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_backend_job_runs(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_backend_job_runs(integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_backend_job_runs(integer, integer) TO service_role;

-- Keep the operator's daily summary independent of PostgREST's row cap.
CREATE FUNCTION public.admin_job_run_summary(p_since timestamptz)
RETURNS TABLE (
  job_name text,
  last_status text,
  last_run_at timestamptz,
  run_count bigint,
  failure_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH recent AS MATERIALIZED (
    SELECT r.id, r.job_name, r.status, r.started_at
    FROM public.backend_job_runs r
    WHERE r.started_at >= p_since
  ), counts AS (
    SELECT r.job_name, count(*) AS run_count,
      count(*) FILTER (WHERE r.status = 'failed') AS failure_count
    FROM recent r
    GROUP BY r.job_name
  ), latest AS (
    SELECT DISTINCT ON (r.job_name) r.job_name, r.status, r.started_at
    FROM recent r
    ORDER BY r.job_name, r.started_at DESC, r.id DESC
  )
  SELECT c.job_name, l.status, l.started_at, c.run_count, c.failure_count
  FROM counts c JOIN latest l USING (job_name)
  ORDER BY c.job_name;
$$;

REVOKE ALL ON FUNCTION public.admin_job_run_summary(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_job_run_summary(timestamptz) TO service_role;

-- Keep stalled workflow adoption both index-backed and fair when the oldest
-- processing runs still have legitimate queue ownership. The previous app
-- query applied LIMIT before checking for pending/processing jobs, so 25 old
-- live runs could permanently hide a later orphan from every sweep.

-- Covers the denormalised canvas foreign key and canvas-scoped maintenance.
CREATE INDEX IF NOT EXISTS workflow_run_step_jobs_canvas_idx
  ON public.workflow_run_step_jobs (canvas_id);

-- The adoption sweep only considers processing runs and orders oldest first.
-- Keeping the predicate in the index avoids carrying terminal/history rows in
-- this hot operational path.
CREATE INDEX IF NOT EXISTS workflow_canvas_runs_stalled_idx
  ON public.workflow_canvas_runs (created_at, id)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.list_stalled_workflow_runs_without_live_jobs(
  p_created_before timestamptz,
  p_limit integer DEFAULT 25
)
RETURNS TABLE (
  id uuid,
  canvas_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_created_before IS NULL THEN
    RAISE EXCEPTION 'created_before is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100';
  END IF;

  RETURN QUERY
  SELECT runs.id, runs.canvas_id
  FROM public.workflow_canvas_runs AS runs
  WHERE runs.status = 'processing'
    AND runs.created_at <= p_created_before
    -- A live ticket already owns this run. Exclude it before ORDER/LIMIT so a
    -- full page of legitimate old work cannot starve later orphaned runs.
    AND NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_step_jobs AS jobs
      WHERE jobs.run_id = runs.id
        AND jobs.status IN ('pending', 'processing')
    )
  ORDER BY runs.created_at ASC, runs.id ASC
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_stalled_workflow_runs_without_live_jobs(
  timestamptz, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_stalled_workflow_runs_without_live_jobs(
  timestamptz, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_stalled_workflow_runs_without_live_jobs(
  timestamptz, integer
) TO service_role;

COMMENT ON FUNCTION public.list_stalled_workflow_runs_without_live_jobs(
  timestamptz, integer
) IS 'Returns the oldest processing workflow runs without pending or processing step jobs. The anti-join is applied before the bounded result limit so live runs cannot starve orphan adoption.';

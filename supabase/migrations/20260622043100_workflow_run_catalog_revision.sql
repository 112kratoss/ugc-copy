ALTER TABLE public.workflow_canvas_runs
  ADD COLUMN IF NOT EXISTS catalog_revision text;

COMMENT ON COLUMN public.workflow_canvas_runs.catalog_revision
  IS 'Generation model catalog revision reviewed when the workflow run was started.';

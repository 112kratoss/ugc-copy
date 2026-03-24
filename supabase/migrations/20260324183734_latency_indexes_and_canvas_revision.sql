ALTER TABLE public.workflow_canvases
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS showcase_saves_user_generation_idx
  ON public.showcase_saves (user_id, generation_id);

CREATE INDEX IF NOT EXISTS workflow_canvases_user_updated_at_idx
  ON public.workflow_canvases (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS workflow_canvas_run_steps_run_started_at_idx
  ON public.workflow_canvas_run_steps (run_id, started_at);

CREATE INDEX IF NOT EXISTS workflow_canvas_runs_canvas_created_at_idx
  ON public.workflow_canvas_runs (canvas_id, created_at DESC);

CREATE INDEX IF NOT EXISTS follows_following_id_idx
  ON public.follows (following_id);

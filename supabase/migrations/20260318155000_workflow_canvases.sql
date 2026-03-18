CREATE TABLE IF NOT EXISTS public.workflow_canvases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users NOT NULL,
  title text NOT NULL DEFAULT 'Untitled workflow',
  graph jsonb NOT NULL,
  viewport jsonb NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}'::jsonb,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.workflow_canvas_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users NOT NULL,
  start_node_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('node', 'branch')),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.workflow_canvas_run_steps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid REFERENCES public.workflow_canvas_runs(id) ON DELETE CASCADE NOT NULL,
  node_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'blocked')),
  generation_id uuid REFERENCES public.generations(id) ON DELETE SET NULL,
  input_snapshot jsonb,
  output_snapshot jsonb,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz
);

ALTER TABLE public.workflow_canvases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_canvas_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_canvas_run_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own workflow canvases"
  ON public.workflow_canvases FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workflow canvases"
  ON public.workflow_canvases FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workflow canvases"
  ON public.workflow_canvases FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own workflow canvases"
  ON public.workflow_canvases FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own workflow runs"
  ON public.workflow_canvas_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workflow runs"
  ON public.workflow_canvas_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workflow runs"
  ON public.workflow_canvas_runs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
      AND runs.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
      AND runs.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their own workflow run steps"
  ON public.workflow_canvas_run_steps FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.workflow_canvas_runs runs
      WHERE runs.id = workflow_canvas_run_steps.run_id
      AND runs.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.touch_workflow_canvas_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_canvases_set_updated_at ON public.workflow_canvases;
CREATE TRIGGER workflow_canvases_set_updated_at
BEFORE UPDATE ON public.workflow_canvases
FOR EACH ROW
EXECUTE FUNCTION public.touch_workflow_canvas_updated_at();

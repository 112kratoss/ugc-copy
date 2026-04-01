ALTER TABLE public.workflow_canvases
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

CREATE TABLE IF NOT EXISTS public.workflow_canvas_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users NOT NULL,
  title text NOT NULL,
  graph jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  kind text NOT NULL CHECK (kind IN ('draft', 'published')),
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.workflow_canvas_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own workflow canvas history"
  ON public.workflow_canvas_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workflow canvas history"
  ON public.workflow_canvas_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS workflow_canvas_history_canvas_created_at_idx
  ON public.workflow_canvas_history (canvas_id, created_at DESC);

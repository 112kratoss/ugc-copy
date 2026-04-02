CREATE TABLE IF NOT EXISTS public.workflow_shares (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  source_canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE SET NULL,
  source_revision integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  graph jsonb NOT NULL,
  node_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  import_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.workflow_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view workflow shares"
  ON public.workflow_shares FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Users can create their own workflow shares"
  ON public.workflow_shares FOR INSERT
  WITH CHECK (auth.uid() = owner_user_id);

CREATE INDEX IF NOT EXISTS workflow_shares_owner_created_at_idx
  ON public.workflow_shares (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_shares_source_canvas_created_at_idx
  ON public.workflow_shares (source_canvas_id, created_at DESC);

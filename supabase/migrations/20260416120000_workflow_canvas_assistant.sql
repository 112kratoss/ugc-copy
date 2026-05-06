CREATE TABLE IF NOT EXISTS public.workflow_canvas_assistant_proposals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users NOT NULL,
  base_revision integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'applied', 'discarded')),
  summary text NOT NULL,
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_graph jsonb NOT NULL,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL,
  applied_at timestamptz,
  discarded_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.workflow_canvas_assistant_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  canvas_id uuid REFERENCES public.workflow_canvases(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  proposal_id uuid REFERENCES public.workflow_canvas_assistant_proposals(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.workflow_canvas_assistant_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_canvas_assistant_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages FOR UPDATE
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS workflow_canvas_assistant_proposals_canvas_created_at_idx
  ON public.workflow_canvas_assistant_proposals (canvas_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_canvas_assistant_messages_canvas_created_at_idx
  ON public.workflow_canvas_assistant_messages (canvas_id, created_at ASC);

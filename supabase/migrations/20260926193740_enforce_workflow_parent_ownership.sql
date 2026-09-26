-- A child's user_id alone does not prove ownership of its parent.
-- Restrictive policies compose with existing CRUD and active-identity policies.
-- Keep all installed-client grants; service-role jobs/merges retain their boundary.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE POLICY workflow_parent_owned
ON public.workflow_canvas_history AS RESTRICTIVE FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_history.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_history.user_id
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_history.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_history.user_id
  )
);

CREATE POLICY workflow_parent_owned
ON public.workflow_canvas_runs AS RESTRICTIVE FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_runs.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_runs.user_id
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_runs.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_runs.user_id
  )
);

CREATE POLICY workflow_parent_owned
ON public.workflow_canvas_assistant_proposals AS RESTRICTIVE FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_assistant_proposals.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_assistant_proposals.user_id
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_assistant_proposals.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_assistant_proposals.user_id
  )
);

CREATE POLICY workflow_parent_owned
ON public.workflow_canvas_assistant_messages AS RESTRICTIVE FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_assistant_messages.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_assistant_messages.user_id
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.workflow_canvases AS canvas
    WHERE canvas.id = workflow_canvas_assistant_messages.canvas_id
      AND canvas.user_id = (SELECT auth.uid())
      AND canvas.user_id = workflow_canvas_assistant_messages.user_id
  )
);

-- A message's optional proposal must also belong to its canvas, not merely
-- to the same user. The referenced proposal's own RLS validates its parent.
CREATE POLICY workflow_message_proposal_owned
ON public.workflow_canvas_assistant_messages AS RESTRICTIVE FOR ALL TO authenticated
USING (
  proposal_id IS NULL OR EXISTS (
    SELECT 1 FROM public.workflow_canvas_assistant_proposals AS proposal
    WHERE proposal.id = workflow_canvas_assistant_messages.proposal_id
      AND proposal.canvas_id = workflow_canvas_assistant_messages.canvas_id
      AND proposal.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  proposal_id IS NULL OR EXISTS (
    SELECT 1 FROM public.workflow_canvas_assistant_proposals AS proposal
    WHERE proposal.id = workflow_canvas_assistant_messages.proposal_id
      AND proposal.canvas_id = workflow_canvas_assistant_messages.canvas_id
      AND proposal.user_id = (SELECT auth.uid())
  )
);

-- Run-step policies already enforce run ownership. Apply the same boundary to
-- an optional generated result using only the existing safe SELECT columns.
CREATE POLICY workflow_step_generation_owned
ON public.workflow_canvas_run_steps AS RESTRICTIVE FOR ALL TO authenticated
USING (
  generation_id IS NULL OR EXISTS (
    SELECT 1 FROM public.generations AS generation
    WHERE generation.id = workflow_canvas_run_steps.generation_id
      AND generation.user_id = (SELECT auth.uid())
  )
)
WITH CHECK (
  generation_id IS NULL OR EXISTS (
    SELECT 1 FROM public.generations AS generation
    WHERE generation.id = workflow_canvas_run_steps.generation_id
      AND generation.user_id = (SELECT auth.uid())
  )
);

COMMIT;

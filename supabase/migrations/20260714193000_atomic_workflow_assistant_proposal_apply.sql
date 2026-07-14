CREATE OR REPLACE FUNCTION public.apply_workflow_canvas_assistant_proposal(
  p_canvas_id uuid,
  p_proposal_id uuid,
  p_merged_graph jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  current_canvas public.workflow_canvases%ROWTYPE;
  current_proposal public.workflow_canvas_assistant_proposals%ROWTYPE;
  application_timestamp timestamptz := timezone('utc'::text, now());
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required.' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO current_proposal
    FROM public.workflow_canvas_assistant_proposals
   WHERE id = p_proposal_id
     AND canvas_id = p_canvas_id
     AND user_id = current_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT *
    INTO current_canvas
    FROM public.workflow_canvases
   WHERE id = p_canvas_id
     AND user_id = current_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF current_proposal.status <> 'ready' THEN
    RETURN jsonb_build_object(
      'outcome', 'proposal_not_ready',
      'proposal', to_jsonb(current_proposal) - 'user_id'
    );
  END IF;

  IF current_canvas.revision <> current_proposal.base_revision THEN
    UPDATE public.workflow_canvas_assistant_proposals
       SET status = 'discarded',
           discarded_at = application_timestamp
     WHERE id = current_proposal.id
       AND status = 'ready'
     RETURNING * INTO current_proposal;

    RETURN jsonb_build_object(
      'outcome', 'conflict',
      'canvas', to_jsonb(current_canvas) - 'user_id',
      'proposal', to_jsonb(current_proposal) - 'user_id'
    );
  END IF;

  IF p_merged_graph IS NULL OR jsonb_typeof(p_merged_graph) <> 'object' THEN
    RAISE EXCEPTION 'A normalized workflow graph is required.' USING ERRCODE = '22023';
  END IF;

  IF current_canvas.graph IS DISTINCT FROM p_merged_graph THEN
    UPDATE public.workflow_canvases
       SET graph = p_merged_graph,
           viewport = COALESCE(p_merged_graph -> 'viewport', current_canvas.viewport),
           revision = current_canvas.revision + 1,
           status = CASE WHEN current_canvas.status = 'published' THEN 'draft' ELSE current_canvas.status END
     WHERE id = current_canvas.id
       AND user_id = current_user_id
       AND revision = current_canvas.revision
     RETURNING * INTO current_canvas;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Workflow canvas revision changed during proposal application.' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.workflow_canvas_history (
      canvas_id,
      user_id,
      title,
      graph,
      revision,
      kind
    ) VALUES (
      current_canvas.id,
      current_user_id,
      current_canvas.title,
      current_canvas.graph,
      current_canvas.revision,
      'draft'
    );
  END IF;

  UPDATE public.workflow_canvas_assistant_proposals
     SET status = 'applied',
         applied_at = application_timestamp
   WHERE id = current_proposal.id
     AND user_id = current_user_id
     AND status = 'ready'
   RETURNING * INTO current_proposal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workflow proposal changed during application.' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'canvas', to_jsonb(current_canvas) - 'user_id',
    'proposal', to_jsonb(current_proposal) - 'user_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_workflow_canvas_assistant_proposal(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_workflow_canvas_assistant_proposal(uuid, uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.apply_workflow_canvas_assistant_proposal(uuid, uuid, jsonb)
  IS 'Atomically applies a ready assistant proposal, advances the canvas revision, records history, and finalizes proposal state.';

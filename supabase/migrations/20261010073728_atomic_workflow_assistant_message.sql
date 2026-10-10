-- Persist a replacement proposal, its conversation and the paid outcome in one
-- transaction. A rejected write preserves the previous usable proposal.
CREATE OR REPLACE FUNCTION public.complete_workflow_assistant_message(
  p_event_id uuid,
  p_canvas_id uuid,
  p_user_id uuid,
  p_base_revision integer,
  p_content text,
  p_reply text,
  p_summary text,
  p_diff jsonb,
  p_proposed_graph jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_event public.ai_usage_events%ROWTYPE;
  v_proposal public.workflow_canvas_assistant_proposals%ROWTYPE;
  v_user_message public.workflow_canvas_assistant_messages%ROWTYPE;
  v_assistant_message public.workflow_canvas_assistant_messages%ROWTYPE;
  v_response jsonb;
  v_settlement jsonb;
  v_remaining integer;
BEGIN
  SELECT * INTO v_event FROM public.ai_usage_events
   WHERE id = p_event_id AND user_id = p_user_id AND feature = 'workflow_assistant'
   FOR UPDATE;
  IF NOT FOUND OR v_event.input_prompt IS DISTINCT FROM left(coalesce(p_content, ''), 5000) THEN
    RAISE EXCEPTION 'Assistant usage event does not match the request' USING ERRCODE = '22023';
  END IF;
  IF v_event.status = 'succeeded' AND NOT coalesce(v_event.refunded, false) THEN
    IF v_event.response_payload #>> '{proposal,canvas_id}' IS DISTINCT FROM p_canvas_id::text THEN
      RAISE EXCEPTION 'Assistant response belongs to another canvas' USING ERRCODE = '22023';
    END IF;
    RETURN v_event.response_payload;
  END IF;
  IF v_event.status <> 'pending' OR coalesce(v_event.refunded, false) THEN
    RAISE EXCEPTION 'Assistant usage event is no longer pending' USING ERRCODE = '22023';
  END IF;
  IF p_content IS NULL OR btrim(p_content) = '' OR p_reply IS NULL OR p_summary IS NULL
     OR p_base_revision IS NULL OR p_base_revision < 0
     OR p_diff IS NULL OR jsonb_typeof(p_diff) <> 'object'
     OR p_proposed_graph IS NULL OR jsonb_typeof(p_proposed_graph) <> 'object' THEN
    RAISE EXCEPTION 'Invalid assistant result' USING ERRCODE = '22023';
  END IF;

  -- Serialize simultaneous replacement messages, including an empty canvas.
  -- Existing apply operations lock a proposal before its parent canvas. Do not
  -- take a parent row lock ahead of the proposal updates below.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workflow-assistant-message:' || p_canvas_id::text, 0));
  IF NOT EXISTS(SELECT 1 FROM public.workflow_canvases WHERE id = p_canvas_id AND user_id = p_user_id) THEN
    RAISE EXCEPTION 'Owned workflow canvas not found' USING ERRCODE = '42501';
  END IF;
  UPDATE public.workflow_canvas_assistant_proposals
     SET status = 'discarded', discarded_at = now()
   WHERE canvas_id = p_canvas_id AND user_id = p_user_id AND status = 'ready';

  INSERT INTO public.workflow_canvas_assistant_proposals
    (canvas_id,user_id,base_revision,status,summary,diff,proposed_graph)
  VALUES(p_canvas_id,p_user_id,p_base_revision,'ready',p_summary,p_diff,p_proposed_graph)
  RETURNING * INTO v_proposal;
  INSERT INTO public.workflow_canvas_assistant_messages(canvas_id,user_id,role,content,proposal_id)
  VALUES(p_canvas_id,p_user_id,'user',p_content,v_proposal.id) RETURNING * INTO v_user_message;
  INSERT INTO public.workflow_canvas_assistant_messages(canvas_id,user_id,role,content,proposal_id)
  VALUES(p_canvas_id,p_user_id,'assistant',p_reply,v_proposal.id) RETURNING * INTO v_assistant_message;

  SELECT credits INTO v_remaining FROM public.profiles WHERE id = p_user_id;
  v_response := jsonb_build_object(
    'messages', jsonb_build_array(to_jsonb(v_user_message) - 'user_id', to_jsonb(v_assistant_message) - 'user_id'),
    'proposal', to_jsonb(v_proposal) - 'user_id',
    'remainingCredits', v_remaining
  );
  v_settlement := public.settle_ai_usage_event(p_event_id, 'succeeded',
    jsonb_build_object('proposalId',v_proposal.id,'summary',p_summary,'reply',p_reply)::text,
    v_response, NULL);
  IF v_settlement->>'status' <> 'succeeded' OR v_settlement->>'event_id' <> p_event_id::text THEN
    RAISE EXCEPTION 'Assistant usage settlement failed';
  END IF;
  RETURN v_response;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_workflow_assistant_message(uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_workflow_assistant_message(uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb)
  TO service_role;

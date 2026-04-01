CREATE OR REPLACE FUNCTION public.record_generation_share_event(
  p_generation_id uuid,
  p_event_type text,
  p_source_surface text,
  p_channel text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_is_public boolean;
BEGIN
  SELECT is_public
  INTO v_is_public
  FROM public.generations
  WHERE id = p_generation_id;

  IF v_is_public IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'Only public generations can record share events'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.generation_share_events (
    generation_id,
    event_type,
    source_surface,
    channel,
    actor_user_id
  )
  VALUES (
    p_generation_id,
    p_event_type,
    p_source_surface,
    p_channel,
    p_actor_user_id
  );

  IF p_event_type = 'share_click' THEN
    UPDATE public.generations
    SET share_count = COALESCE(share_count, 0) + 1
    WHERE id = p_generation_id;
  ELSIF p_event_type = 'share_visit' THEN
    UPDATE public.generations
    SET share_visit_count = COALESCE(share_visit_count, 0) + 1
    WHERE id = p_generation_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.record_generation_share_event(uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_generation_share_event(uuid, text, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.record_generation_share_event(uuid, text, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_generation_share_event(uuid, text, text, text, uuid) TO service_role;

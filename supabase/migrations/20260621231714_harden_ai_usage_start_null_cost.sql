CREATE OR REPLACE FUNCTION public.start_ai_usage_event(
  p_user_id uuid,
  p_cost integer,
  p_feature text,
  p_provider text,
  p_model text,
  p_medium text,
  p_input_prompt text,
  p_client_request_key_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credits integer;
  v_existing public.ai_usage_events%ROWTYPE;
  v_event_id uuid;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_cost');
  END IF;

  IF nullif(btrim(p_feature), '') IS NULL
     OR nullif(btrim(p_provider), '') IS NULL
     OR nullif(btrim(p_model), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_client_request_key_hash IS NOT NULL
     AND p_client_request_key_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid_idempotency_key');
  END IF;

  SELECT credits
  INTO v_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF p_client_request_key_hash IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.ai_usage_events
    WHERE user_id = p_user_id
      AND feature = p_feature
      AND client_request_key_hash = p_client_request_key_hash
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.status = 'pending' THEN
        RETURN jsonb_build_object(
          'status', 'in_progress',
          'event_id', v_existing.id,
          'remaining_credits', v_credits,
          'cost', v_existing.cost
        );
      END IF;

      IF v_existing.status = 'succeeded' THEN
        RETURN jsonb_build_object(
          'status', 'succeeded_replay',
          'event_id', v_existing.id,
          'remaining_credits', v_credits,
          'cost', v_existing.cost,
          'response_payload', v_existing.response_payload
        );
      END IF;

      RETURN jsonb_build_object(
        'status', 'key_already_used',
        'event_id', v_existing.id,
        'remaining_credits', v_credits,
        'cost', v_existing.cost
      );
    END IF;
  END IF;

  IF v_credits < p_cost THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'required_credits', p_cost
    );
  END IF;

  UPDATE public.profiles
  SET credits = credits - p_cost
  WHERE id = p_user_id
  RETURNING credits INTO v_credits;

  INSERT INTO public.ai_usage_events (
    user_id,
    feature,
    provider,
    model,
    medium,
    cost,
    status,
    input_prompt,
    client_request_key_hash
  )
  VALUES (
    p_user_id,
    btrim(p_feature),
    btrim(p_provider),
    btrim(p_model),
    nullif(btrim(p_medium), ''),
    p_cost,
    'pending',
    left(coalesce(p_input_prompt, ''), 5000),
    p_client_request_key_hash
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'status', 'started',
    'event_id', v_event_id,
    'remaining_credits', v_credits,
    'cost', p_cost
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_ai_usage_event(uuid, integer, text, text, text, text, text, text) TO service_role;

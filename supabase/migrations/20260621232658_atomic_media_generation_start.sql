CREATE OR REPLACE FUNCTION public.start_generation(
  p_user_id uuid,
  p_cost integer,
  p_model text,
  p_prompt text,
  p_category text,
  p_duration integer,
  p_creation_mode text,
  p_source_generation_id uuid,
  p_workflow_settings jsonb,
  p_client_request_key_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credits integer;
  v_existing public.generations%ROWTYPE;
  v_generation_id uuid;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_cost');
  END IF;

  IF p_user_id IS NULL
     OR nullif(btrim(p_model), '') IS NULL
     OR nullif(btrim(p_category), '') IS NULL
     OR btrim(p_category) NOT IN ('image', 'video', 'audio')
     OR (p_duration IS NOT NULL AND p_duration < 0)
     OR (p_creation_mode IS NOT NULL AND p_creation_mode <> 'motion') THEN
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
    FROM public.generations
    WHERE user_id = p_user_id
      AND client_request_key_hash = p_client_request_key_hash
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.prediction_id IS NOT NULL THEN
        RETURN jsonb_build_object(
          'status', 'already_started',
          'generation_id', v_existing.id,
          'prediction_id', v_existing.prediction_id,
          'remaining_credits', v_credits,
          'cost', v_existing.cost
        );
      END IF;

      IF v_existing.status IN ('pending', 'waiting', 'processing') THEN
        RETURN jsonb_build_object(
          'status', 'in_progress',
          'generation_id', v_existing.id,
          'remaining_credits', v_credits,
          'cost', v_existing.cost
        );
      END IF;

      RETURN jsonb_build_object(
        'status', 'key_already_used',
        'generation_id', v_existing.id,
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

  INSERT INTO public.generations (
    user_id,
    model,
    cost,
    duration,
    client_request_key_hash,
    prompt,
    category,
    creation_mode,
    source_generation_id,
    workflow_settings,
    prediction_id,
    status
  )
  VALUES (
    p_user_id,
    btrim(p_model),
    p_cost,
    p_duration,
    p_client_request_key_hash,
    nullif(left(coalesce(p_prompt, ''), 5000), ''),
    btrim(p_category),
    p_creation_mode,
    p_source_generation_id,
    coalesce(p_workflow_settings, '{}'::jsonb),
    null,
    'pending'
  )
  RETURNING id INTO v_generation_id;

  RETURN jsonb_build_object(
    'status', 'started',
    'generation_id', v_generation_id,
    'remaining_credits', v_credits,
    'cost', p_cost
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) TO service_role;

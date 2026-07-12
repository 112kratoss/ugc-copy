-- Keep graph-template recipes and intermediate generations behind backend-only
-- template-run projections. A template generation is private from the same
-- transaction that reserves its credits and links its run step.

CREATE UNIQUE INDEX IF NOT EXISTS generations_template_run_step_unique_idx
  ON public.generations (template_run_step_id)
  WHERE template_run_step_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.start_template_generation(
  p_user_id uuid,
  p_template_run_id uuid,
  p_template_run_step_id uuid,
  p_cost integer,
  p_model text,
  p_category text,
  p_duration integer,
  p_creation_mode text,
  p_source_generation_id uuid,
  p_client_request_key_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credits integer;
  v_run public.template_runs%ROWTYPE;
  v_step public.template_run_steps%ROWTYPE;
  v_existing public.generations%ROWTYPE;
  v_generation_id uuid;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_cost');
  END IF;

  IF p_user_id IS NULL
     OR p_template_run_id IS NULL
     OR p_template_run_step_id IS NULL
     OR nullif(btrim(p_model), '') IS NULL
     OR btrim(coalesce(p_category, '')) NOT IN ('image', 'video')
     OR (p_duration IS NOT NULL AND p_duration < 0)
     OR p_creation_mode IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_client_request_key_hash IS NOT NULL
     AND p_client_request_key_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid_idempotency_key');
  END IF;

  SELECT *
  INTO v_run
  FROM public.template_runs
  WHERE id = p_template_run_id
  FOR UPDATE;

  IF NOT FOUND OR v_run.user_id <> p_user_id THEN
    RETURN jsonb_build_object('status', 'template_context_not_found');
  END IF;

  IF v_run.status IN ('succeeded', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'invalid_template_context');
  END IF;

  SELECT *
  INTO v_step
  FROM public.template_run_steps
  WHERE id = p_template_run_step_id
    AND run_id = p_template_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'template_context_not_found');
  END IF;

  IF v_step.kind <> 'generation'
     OR v_step.media_kind <> btrim(p_category) THEN
    RETURN jsonb_build_object('status', 'invalid_template_context');
  END IF;

  SELECT credits
  INTO v_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_step.generation_id IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generations
    WHERE id = v_step.generation_id
      AND user_id = p_user_id
      AND template_run_id = p_template_run_id
      AND template_run_step_id = p_template_run_step_id;

    IF NOT FOUND
       OR p_client_request_key_hash IS DISTINCT FROM v_existing.client_request_key_hash THEN
      RETURN jsonb_build_object('status', 'template_step_already_started');
    END IF;

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

  IF v_step.status <> 'queued' THEN
    RETURN jsonb_build_object('status', 'invalid_template_context');
  END IF;

  IF p_client_request_key_hash IS NOT NULL THEN
    SELECT *
    INTO v_existing
    FROM public.generations
    WHERE user_id = p_user_id
      AND client_request_key_hash = p_client_request_key_hash
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.template_run_id = p_template_run_id
         AND v_existing.template_run_step_id = p_template_run_step_id THEN
        UPDATE public.template_run_steps
        SET generation_id = v_existing.id,
            status = CASE
              WHEN v_existing.status IN ('pending', 'waiting', 'processing') THEN 'processing'
              ELSE status
            END,
            started_at = COALESCE(started_at, v_existing.created_at)
        WHERE id = p_template_run_step_id;

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
      'required_credits', p_cost,
      'cost', p_cost
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
    status,
    template_run_id,
    template_run_step_id
  )
  VALUES (
    p_user_id,
    btrim(p_model),
    p_cost,
    p_duration,
    p_client_request_key_hash,
    null,
    btrim(p_category),
    null,
    p_source_generation_id,
    '{}'::jsonb,
    null,
    'pending',
    p_template_run_id,
    p_template_run_step_id
  )
  RETURNING id INTO v_generation_id;

  UPDATE public.template_run_steps
  SET generation_id = v_generation_id,
      status = 'processing',
      error_message = null,
      started_at = COALESCE(started_at, timezone('utc'::text, now()))
  WHERE id = p_template_run_step_id;

  RETURN jsonb_build_object(
    'status', 'started',
    'generation_id', v_generation_id,
    'remaining_credits', v_credits,
    'cost', p_cost
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) FROM anon;
REVOKE ALL ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) TO service_role;

DROP POLICY IF EXISTS "Users can view accessible generations" ON public.generations;
DROP POLICY IF EXISTS "Users can create own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can update own generations" ON public.generations;

CREATE POLICY "Users can view accessible ordinary generations"
  ON public.generations FOR SELECT TO public
  USING (
    template_run_id IS NULL
    AND template_run_step_id IS NULL
    AND (is_public = true OR (SELECT auth.uid()) = user_id)
  );

CREATE POLICY "Users can create own ordinary generations"
  ON public.generations FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND template_run_id IS NULL
    AND template_run_step_id IS NULL
  );

CREATE POLICY "Users can update own ordinary generations"
  ON public.generations FOR UPDATE TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND template_run_id IS NULL
    AND template_run_step_id IS NULL
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND template_run_id IS NULL
    AND template_run_step_id IS NULL
  );

COMMENT ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) IS 'Atomically charges a consumer and creates a backend-private generation linked to one template run step.';

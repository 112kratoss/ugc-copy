-- Promote exactly one successful, non-test template generation into Studio while
-- keeping every input, intermediate generation, prompt, and graph private.

ALTER TABLE public.template_runs
  ADD COLUMN IF NOT EXISTS result_generation_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'template_runs_result_generation_id_fkey'
      AND conrelid = 'public.template_runs'::regclass
  ) THEN
    ALTER TABLE public.template_runs
      ADD CONSTRAINT template_runs_result_generation_id_fkey
      FOREIGN KEY (result_generation_id)
      REFERENCES public.generations(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.template_runs
  VALIDATE CONSTRAINT template_runs_result_generation_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS template_runs_result_generation_unique_idx
  ON public.template_runs (result_generation_id)
  WHERE result_generation_id IS NOT NULL;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS studio_visible boolean;

-- Fail closed during rollout. Ordinary generations retain their historical
-- Studio behavior; private template generations start hidden.
UPDATE public.generations
SET studio_visible = (
  template_run_id IS NULL
  AND template_run_step_id IS NULL
)
WHERE studio_visible IS NULL;

-- Recover only unambiguous historical results. A successful output step must
-- agree with a successful generation owned by the same run and user. Runs with
-- duplicate URL matches stay hidden instead of risking an intermediate leak.
WITH candidate_matches AS (
  SELECT
    runs.id AS run_id,
    generations.id AS generation_id,
    count(*) OVER (PARTITION BY runs.id) AS match_count
  FROM public.template_runs AS runs
  JOIN public.template_run_steps AS output_steps
    ON output_steps.run_id = runs.id
   AND output_steps.node_id = runs.output_node_id
   AND output_steps.status = 'succeeded'
   AND output_steps.output_url = runs.result_url
   AND NOT EXISTS (
     SELECT 1
     FROM public.template_run_steps AS newer_output_steps
     WHERE newer_output_steps.run_id = output_steps.run_id
       AND newer_output_steps.node_id = output_steps.node_id
       AND newer_output_steps.attempt > output_steps.attempt
   )
  JOIN public.generations AS generations
    ON generations.template_run_id = runs.id
   AND generations.user_id = runs.user_id
   AND generations.status = 'succeeded'
   AND generations.output_url = runs.result_url
  JOIN public.template_run_steps AS generation_steps
    ON generation_steps.id = generations.template_run_step_id
   AND generation_steps.run_id = runs.id
   AND generation_steps.generation_id = generations.id
   AND generation_steps.status = 'succeeded'
   AND generation_steps.output_url = runs.result_url
   AND NOT EXISTS (
     SELECT 1
     FROM public.template_run_steps AS newer_generation_steps
     WHERE newer_generation_steps.run_id = generation_steps.run_id
       AND newer_generation_steps.node_id = generation_steps.node_id
       AND newer_generation_steps.attempt > generation_steps.attempt
   )
  WHERE runs.status = 'succeeded'
    AND runs.is_test = false
    AND runs.result_url IS NOT NULL
    AND runs.result_generation_id IS NULL
), unambiguous_matches AS (
  SELECT run_id, generation_id
  FROM candidate_matches
  WHERE match_count = 1
)
UPDATE public.template_runs AS runs
SET result_generation_id = matches.generation_id
FROM unambiguous_matches AS matches
WHERE runs.id = matches.run_id;

UPDATE public.generations AS generations
SET studio_visible = true
FROM public.template_runs AS runs
WHERE runs.result_generation_id = generations.id
  AND runs.status = 'succeeded'
  AND runs.is_test = false;

ALTER TABLE public.generations
  ALTER COLUMN studio_visible SET DEFAULT true,
  ALTER COLUMN studio_visible SET NOT NULL;

CREATE INDEX IF NOT EXISTS generations_owner_studio_visible_created_idx
  ON public.generations (user_id, created_at DESC)
  WHERE studio_visible = true;

-- Recreate the private start RPC so template rows explicitly override the
-- ordinary-generation default from the first statement of their lifecycle.
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
    template_run_step_id,
    studio_visible
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
    p_template_run_step_id,
    false
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

-- New code supplies the exact upstream generation, including when the selected
-- output node is an approval gate whose result URL came from that generation.
CREATE OR REPLACE FUNCTION public.record_template_run_success(
  p_run_id uuid,
  p_result_url text,
  p_credits_used integer,
  p_result_generation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_run public.template_runs%ROWTYPE;
  v_generation public.generations%ROWTYPE;
  v_should_count_usage boolean;
BEGIN
  IF p_run_id IS NULL
     OR p_result_generation_id IS NULL
     OR nullif(btrim(coalesce(p_result_url, '')), '') IS NULL THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_run
  FROM public.template_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND OR v_run.status IN ('failed', 'cancelled') THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.template_run_steps AS run_step
    WHERE run_step.run_id = v_run.id
      AND NOT EXISTS (
        SELECT 1
        FROM public.template_run_steps AS newer_run_step
        WHERE newer_run_step.run_id = run_step.run_id
          AND newer_run_step.node_id = run_step.node_id
          AND newer_run_step.attempt > run_step.attempt
      )
      AND run_step.status <> 'succeeded'
  ) THEN
    RETURN false;
  END IF;

  -- The selected output itself must be the latest successful attempt and agree
  -- with the exact URL being committed.
  IF NOT EXISTS (
    SELECT 1
    FROM public.template_run_steps AS output_step
    WHERE output_step.run_id = v_run.id
      AND output_step.node_id = v_run.output_node_id
      AND output_step.status = 'succeeded'
      AND output_step.output_url = p_result_url
      AND NOT EXISTS (
        SELECT 1
        FROM public.template_run_steps AS newer_output_step
        WHERE newer_output_step.run_id = output_step.run_id
          AND newer_output_step.node_id = output_step.node_id
          AND newer_output_step.attempt > output_step.attempt
      )
  ) THEN
    RETURN false;
  END IF;

  SELECT generations.*
  INTO v_generation
  FROM public.generations AS generations
  JOIN public.template_run_steps AS generation_step
    ON generation_step.id = generations.template_run_step_id
   AND generation_step.run_id = v_run.id
   AND generation_step.generation_id = generations.id
   AND generation_step.kind = 'generation'
   AND generation_step.status = 'succeeded'
   AND generation_step.output_url = p_result_url
  WHERE generations.id = p_result_generation_id
    AND generations.user_id = v_run.user_id
    AND generations.template_run_id = v_run.id
    AND generations.status = 'succeeded'
    AND generations.output_url = p_result_url
    AND NOT EXISTS (
      SELECT 1
      FROM public.template_run_steps AS newer_generation_step
      WHERE newer_generation_step.run_id = generation_step.run_id
        AND newer_generation_step.node_id = generation_step.node_id
        AND newer_generation_step.attempt > generation_step.attempt
    )
  FOR UPDATE OF generations;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_run.result_generation_id IS NOT NULL
     AND v_run.result_generation_id <> p_result_generation_id THEN
    RETURN false;
  END IF;

  v_should_count_usage := v_run.usage_counted_at IS NULL;

  UPDATE public.generations
  SET studio_visible = false
  WHERE template_run_id = v_run.id
    AND studio_visible = true;

  UPDATE public.template_runs
  SET status = 'succeeded',
      result_url = p_result_url,
      result_generation_id = p_result_generation_id,
      credits_used = GREATEST(0, COALESCE(p_credits_used, 0)),
      estimated_remaining_credits = 0,
      completed_at = COALESCE(completed_at, timezone('utc'::text, now())),
      usage_counted_at = COALESCE(usage_counted_at, timezone('utc'::text, now())),
      error_message = null
  WHERE id = v_run.id;

  UPDATE public.generations
  SET studio_visible = NOT v_run.is_test
  WHERE id = p_result_generation_id;

  IF v_should_count_usage AND NOT v_run.is_test THEN
    UPDATE public.templates
    SET use_count = use_count + 1
    WHERE id = v_run.template_id
      AND status = 'active'
      AND is_active = true;
  END IF;

  RETURN true;
END;
$$;

-- Rolling-deploy compatibility for older web instances. This wrapper resolves
-- a successful generation only inside the owned run and matching result URL,
-- then delegates to the canonical four-argument implementation.
CREATE OR REPLACE FUNCTION public.record_template_run_success(
  p_run_id uuid,
  p_result_url text,
  p_credits_used integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_generation_id uuid;
BEGIN
  SELECT generations.id
  INTO v_generation_id
  FROM public.template_runs AS runs
  JOIN public.template_run_steps AS output_step
    ON output_step.run_id = runs.id
   AND output_step.node_id = runs.output_node_id
   AND output_step.status = 'succeeded'
   AND output_step.output_url = p_result_url
   AND NOT EXISTS (
     SELECT 1
     FROM public.template_run_steps AS newer_output_step
     WHERE newer_output_step.run_id = output_step.run_id
       AND newer_output_step.node_id = output_step.node_id
       AND newer_output_step.attempt > output_step.attempt
   )
  JOIN public.generations AS generations
    ON generations.template_run_id = runs.id
   AND generations.user_id = runs.user_id
   AND generations.status = 'succeeded'
   AND generations.output_url = p_result_url
  JOIN public.template_run_steps AS generation_step
    ON generation_step.id = generations.template_run_step_id
   AND generation_step.run_id = runs.id
   AND generation_step.generation_id = generations.id
   AND generation_step.kind = 'generation'
   AND generation_step.status = 'succeeded'
   AND generation_step.output_url = p_result_url
   AND NOT EXISTS (
     SELECT 1
     FROM public.template_run_steps AS newer_generation_step
     WHERE newer_generation_step.run_id = generation_step.run_id
       AND newer_generation_step.node_id = generation_step.node_id
       AND newer_generation_step.attempt > generation_step.attempt
   )
  WHERE runs.id = p_run_id
    AND runs.status NOT IN ('failed', 'cancelled')
    AND nullif(btrim(coalesce(p_result_url, '')), '') IS NOT NULL
  ORDER BY
    (generation_step.id = output_step.id) DESC,
    generation_step.attempt DESC,
    generations.completed_at DESC NULLS LAST,
    generations.created_at DESC
  LIMIT 1;

  IF v_generation_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN public.record_template_run_success(
    p_run_id,
    p_result_url,
    p_credits_used,
    v_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) TO service_role;

REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_template_run_success(uuid, text, integer, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_template_run_success(uuid, text, integer)
  TO service_role;

COMMENT ON COLUMN public.template_runs.result_generation_id
  IS 'Canonical final generation for this run. Only a successful non-test run may expose it in Studio.';
COMMENT ON COLUMN public.generations.studio_visible
  IS 'Backend-controlled Studio projection flag. Template intermediates and creator tests remain false.';

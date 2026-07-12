-- Provider task creation can fail after a template generation has atomically
-- reserved credits but before a provider task id exists. Settle that narrow
-- state in one transaction so retries cannot double-refund the consumer and
-- the private run keeps a safe, actionable reason.

ALTER TABLE public.template_runs
  ADD COLUMN IF NOT EXISTS client_request_key_hash text;

ALTER TABLE public.template_runs
  DROP CONSTRAINT IF EXISTS template_runs_client_request_key_hash_format;
ALTER TABLE public.template_runs
  ADD CONSTRAINT template_runs_client_request_key_hash_format
  CHECK (
    client_request_key_hash IS NULL
    OR client_request_key_hash ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS template_runs_create_idempotency_unique_idx
  ON public.template_runs (user_id, template_id, is_test, client_request_key_hash)
  WHERE client_request_key_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.settle_template_generation_start_failed(
  p_generation_id uuid,
  p_error_message text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_remaining_credits integer;
  v_error_message text;
  v_refunded boolean := false;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.template_run_id IS NULL
     OR v_generation.template_run_step_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_template_context');
  END IF;

  IF v_generation.prediction_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'provider_task_attached',
      'generation_id', v_generation.id
    );
  END IF;

  IF v_generation.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'status', 'already_succeeded',
      'generation_id', v_generation.id
    );
  END IF;

  v_error_message := left(
    coalesce(
      nullif(btrim(p_error_message), ''),
      'The generation provider could not accept this request. Check the uploaded media and try again.'
    ),
    500
  );

  SELECT credits
  INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_generation.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT coalesce(v_generation.refunded, false) THEN
    UPDATE public.profiles
    SET credits = credits + greatest(0, coalesce(v_generation.cost, 0))
    WHERE id = v_generation.user_id
    RETURNING credits INTO v_remaining_credits;
    v_refunded := true;
  END IF;

  UPDATE public.generations
  SET status = 'failed',
      error_message = v_error_message,
      completed_at = coalesce(completed_at, timezone('utc'::text, now())),
      refunded = true,
      client_request_key_hash = null
  WHERE id = v_generation.id;

  UPDATE public.template_run_steps
  SET status = 'failed',
      error_message = v_error_message,
      finished_at = coalesce(finished_at, timezone('utc'::text, now()))
  WHERE id = v_generation.template_run_step_id
    AND run_id = v_generation.template_run_id
    AND generation_id = v_generation.id
    AND status = 'processing';

  RETURN jsonb_build_object(
    'status', CASE WHEN v_refunded THEN 'failed' ELSE 'already_failed' END,
    'generation_id', v_generation.id,
    'refunded', v_refunded OR coalesce(v_generation.refunded, false),
    'remaining_credits', v_remaining_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_template_generation_start_failed(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_template_generation_start_failed(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.settle_template_generation_start_failed(uuid, text)
  IS 'Atomically refunds and records a private template generation that failed before a provider task id was attached.';

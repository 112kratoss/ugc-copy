-- Charge and settle a merged guest's open work against the account.
--
-- merge_guest_account (20260811110000, latest body 20261015054611) moves a
-- guest's balance to the account it registers, drains the guest's profiles row
-- and links it through merged_into_user_id. The guest's generations, template
-- runs and AI-usage events keep the guest's user_id forever, so anything that
-- settles after the merge names the drained row.
--
-- Writes were already safe: profiles_forward_linked_credit_change moves any
-- credit or promotional delta written to a linked row onto the account and
-- keeps the row drained, so every refund paid by user_id has reached the
-- account. What a trigger on the write cannot fix is a decision read from the
-- drained row before the write:
--
--   * start_template_generation locked and read the guest row's balance, so a
--     guest's template run still in progress at sign-up had its next paid step
--     refused as insufficient_credits while the account held the credits;
--   * reserve_generation_promotional_credits read the guest row's promotional
--     balance, so that step could not spend the account's promotional credits
--     first;
--   * settle_generation_start_failed, settle_template_generation_start_failed
--     and settle_ai_usage_event locked the guest row and reported its balance,
--     always zero, as remaining_credits.
--
-- Each is redefined from its latest body with the profile it locks, reads,
-- charges or refunds resolved through canonical_account_id(): the linked
-- account for a merged guest, the id itself for everyone else. Nothing else
-- changes: every row keeps its user_id, each function locks the same rows in
-- the same order with the account's profile in place of the guest's, and the
-- grants are restated as they were.
--
-- Left alone: settle_generation_failed and the two promotional restore
-- triggers only write, and the forwarding trigger already moves those writes.
-- Paths that charge the caller's own id (start_generation, start_ai_usage_event
-- and the AI-usage promotional reservation) never see a merged guest, because
-- admission refuses a merged identity's token.
--
-- canonical_account_id() reads the link without a lock. A call racing the merge
-- itself resolves the guest's id, waits for the merge's row lock and then reads
-- the drained row: a step is refused, as every step was before this change, and
-- a refund still reaches the account through the forwarding trigger.

-- ─── The next paid step of a template run ───────────────────────────────────
--
-- The template-run worker starts each step with the run's own user_id, which
-- for a guest's run stays the guest's id after the merge. The balance check,
-- the row lock and the charge read the account that id belongs to; the run's
-- ownership checks and the new generation row keep the id the run was started
-- under. Unchanged from 20260712063730 otherwise.
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
  v_account_id uuid;
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

  -- The run, its steps and its generations keep the id they were started
  -- under; the credits are spent from the account that id now belongs to.
  v_account_id := public.canonical_account_id(p_user_id);

  SELECT credits
  INTO v_credits
  FROM public.profiles
  WHERE id = v_account_id
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
  WHERE id = v_account_id
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

REVOKE ALL ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_template_generation(
  uuid, uuid, uuid, integer, text, text, integer, text, uuid, text
) TO service_role;

-- ─── The promotional share of a new generation ───────────────────────────────
--
-- Promotional credits pay first. A step started for a guest's run after the
-- merge is inserted under the guest's id, whose promotional balance is drained
-- to zero, so the share must come from the account's. Unchanged from
-- 20260712123000 otherwise; the trigger that calls it is not touched.
CREATE OR REPLACE FUNCTION public.reserve_generation_promotional_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_promotional_credits integer;
  v_promotional_used integer;
  v_account_id uuid;
BEGIN
  IF coalesce(NEW.cost, 0) <= 0 OR coalesce(NEW.promotional_credits_used, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- A generation keeps the id it was started under; its promotional share
  -- comes from the account that id now belongs to.
  v_account_id := public.canonical_account_id(NEW.user_id);

  SELECT promotional_credits INTO v_promotional_credits
  FROM public.profiles
  WHERE id = v_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_promotional_used := least(NEW.cost, greatest(v_promotional_credits, 0));
  IF v_promotional_used > 0 THEN
    UPDATE public.profiles
    SET promotional_credits = promotional_credits - v_promotional_used
    WHERE id = v_account_id;
    NEW.promotional_credits_used := v_promotional_used;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_generation_promotional_credits() FROM PUBLIC, anon, authenticated;

-- ─── Refunds of starts the provider never accepted ───────────────────────────
--
-- The refund already reached the account through the forwarding trigger; what
-- changes is that the lock and the remaining balance reported back are the
-- account's rather than the drained row's. Unchanged from 20260809120000
-- otherwise.
CREATE OR REPLACE FUNCTION public.settle_generation_start_failed(
  p_generation_id uuid,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_remaining_credits integer;
  v_refunded boolean := false;
  v_account_id uuid;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.prediction_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'provider_task_attached', 'generation_id', v_generation.id);
  END IF;

  IF v_generation.status = 'succeeded' THEN
    RETURN jsonb_build_object('status', 'already_succeeded', 'generation_id', v_generation.id);
  END IF;

  v_account_id := public.canonical_account_id(v_generation.user_id);

  SELECT credits INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT coalesce(v_generation.refunded, false) THEN
    UPDATE public.profiles
    SET credits = credits + greatest(0, coalesce(v_generation.cost, 0))
    WHERE id = v_account_id
    RETURNING credits INTO v_remaining_credits;
    v_refunded := true;
  END IF;

  UPDATE public.generations
  SET status = 'failed',
      error_message = left(coalesce(nullif(btrim(p_error_message), ''), 'The generation provider could not accept this request.'), 500),
      completed_at = coalesce(completed_at, timezone('utc'::text, now())),
      refunded = true,
      client_request_key_hash = NULL
  WHERE id = v_generation.id;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_refunded THEN 'failed' ELSE 'already_failed' END,
    'generation_id', v_generation.id,
    'refunded', v_refunded OR coalesce(v_generation.refunded, false),
    'remaining_credits', v_remaining_credits,
    'submission_unknown', v_generation.submission_unknown_at IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.settle_generation_start_failed(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_generation_start_failed(uuid, text) TO service_role;

-- The template twin of the function above, unchanged from 20260711201026
-- except for the account it locks, refunds and reports.
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
  v_account_id uuid;
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

  v_account_id := public.canonical_account_id(v_generation.user_id);

  SELECT credits
  INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF NOT coalesce(v_generation.refunded, false) THEN
    UPDATE public.profiles
    SET credits = credits + greatest(0, coalesce(v_generation.cost, 0))
    WHERE id = v_account_id
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

-- ─── AI-usage settlement ─────────────────────────────────────────────────────
--
-- Its success, replay and refund answers report remaining_credits, read until
-- now from the event's own user_id. Unchanged from 20260714110000 except for
-- the account it reads and refunds; refund_ai_usage_event delegates here and is
-- not touched.
CREATE OR REPLACE FUNCTION public.settle_ai_usage_event(
  p_event_id uuid,
  p_outcome text,
  p_output_text text DEFAULT NULL,
  p_response_payload jsonb DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_event public.ai_usage_events%ROWTYPE;
  v_remaining_credits integer;
  v_account_id uuid;
BEGIN
  IF p_event_id IS NULL OR p_outcome NOT IN ('succeeded', 'refunded') THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'settled', false);
  END IF;

  SELECT *
  INTO v_event
  FROM public.ai_usage_events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'not_found',
      'settled', false,
      'event_id', p_event_id
    );
  END IF;

  v_account_id := public.canonical_account_id(v_event.user_id);

  SELECT credits
  INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_account_id;

  IF p_outcome = 'succeeded' THEN
    IF v_event.status = 'succeeded' AND NOT coalesce(v_event.refunded, false) THEN
      RETURN jsonb_build_object(
        'status', 'already_succeeded',
        'settled', false,
        'event_id', v_event.id,
        'remaining_credits', v_remaining_credits,
        'response_payload', v_event.response_payload
      );
    END IF;

    IF v_event.status <> 'pending' OR coalesce(v_event.refunded, false) THEN
      RETURN jsonb_build_object(
        'status', 'transition_conflict',
        'settled', false,
        'event_id', v_event.id,
        'current_status', v_event.status,
        'refunded', coalesce(v_event.refunded, false)
      );
    END IF;

    UPDATE public.ai_usage_events
    SET status = 'succeeded',
        refunded = false,
        output_text = left(coalesce(p_output_text, ''), 5000),
        response_payload = p_response_payload,
        error_message = NULL,
        settled_at = timezone('utc'::text, now())
    WHERE id = v_event.id;

    RETURN jsonb_build_object(
      'status', 'succeeded',
      'settled', true,
      'event_id', v_event.id,
      'remaining_credits', v_remaining_credits,
      'response_payload', p_response_payload
    );
  END IF;

  IF v_event.status = 'refunded' OR coalesce(v_event.refunded, false) THEN
    RETURN jsonb_build_object(
      'status', 'already_refunded',
      'settled', false,
      'event_id', v_event.id,
      'remaining_credits', v_remaining_credits
    );
  END IF;

  IF v_event.status NOT IN ('pending', 'failed') THEN
    RETURN jsonb_build_object(
      'status', 'transition_conflict',
      'settled', false,
      'event_id', v_event.id,
      'current_status', v_event.status,
      'refunded', coalesce(v_event.refunded, false)
    );
  END IF;

  IF v_event.cost < 0 THEN
    RAISE EXCEPTION 'AI usage event % has an invalid negative cost', v_event.id;
  END IF;

  UPDATE public.profiles
  SET credits = credits + v_event.cost
  WHERE id = v_account_id
  RETURNING credits INTO v_remaining_credits;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for AI usage event %', v_event.id;
  END IF;

  UPDATE public.ai_usage_events
  SET status = 'refunded',
      refunded = true,
      error_message = left(coalesce(p_error_message, 'Unknown error'), 1000),
      settled_at = timezone('utc'::text, now())
  WHERE id = v_event.id;

  RETURN jsonb_build_object(
    'status', 'refunded',
    'settled', true,
    'event_id', v_event.id,
    'remaining_credits', v_remaining_credits
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) TO service_role;

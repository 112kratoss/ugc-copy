-- Settle paid non-generation AI usage through one locked state transition.
-- The function is deliberately retry-safe: a repeated success/refund reports the
-- durable state without applying the credit effect twice.

ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

UPDATE public.ai_usage_events
SET settled_at = created_at
WHERE settled_at IS NULL
  AND status IN ('succeeded', 'refunded');

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

  SELECT credits
  INTO v_remaining_credits
  FROM public.profiles
  WHERE id = v_event.user_id;

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
  WHERE id = v_event.user_id
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

-- Preserve the old boolean RPC for rolling deployments while routing it through
-- the same lock and state machine.
CREATE OR REPLACE FUNCTION public.refund_ai_usage_event(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.settle_ai_usage_event(
    p_event_id,
    'refunded',
    NULL,
    NULL,
    'AI usage request failed'
  );
  RETURN v_result->>'status' = 'refunded';
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_usage_event(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_ai_usage_event(uuid, text, text, jsonb, text)
  IS 'Atomically and idempotently settles a paid AI usage event after locking it; refunds credits at most once.';

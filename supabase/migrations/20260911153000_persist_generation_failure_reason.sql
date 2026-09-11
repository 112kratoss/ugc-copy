-- Persist the provider's failure reason when settling a failed generation.
--
-- `settle_generation_failed` previously took only the prediction id and a
-- completion timestamp, so the provider's `failMsg` -- the single piece of
-- information that explains *why* a generation failed -- was read by the status
-- services into a local variable, returned in an HTTP body nothing stores, and
-- discarded. Every failed generation therefore landed with
-- `generations.error_message = NULL`, leaving both users and operators unable to
-- tell a content-policy rejection from a provider outage.
--
-- Postgres cannot change a function's arity with CREATE OR REPLACE -- doing so
-- registers a second overload and makes the existing two-argument calls
-- ambiguous -- so the old signature is dropped first and recreated with the
-- extra argument.

DROP FUNCTION IF EXISTS public.settle_generation_failed(text, timestamp with time zone);

CREATE OR REPLACE FUNCTION public.settle_generation_failed(
  p_prediction_id text,
  p_completed_at timestamp with time zone DEFAULT NULL,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_completed_at timestamp with time zone := coalesce(p_completed_at, now());
  v_error_message text := left(nullif(btrim(coalesce(p_error_message, '')), ''), 500);
  v_profile_updates integer := 0;
  v_refunded boolean := false;
BEGIN
  IF btrim(coalesce(p_prediction_id, '')) = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_generation
  FROM public.generations
  WHERE prediction_id = btrim(p_prediction_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'status', 'already_succeeded',
      'generation_id', v_generation.id,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  IF NOT coalesce(v_generation.refunded, false)
    AND coalesce(v_generation.cost, 0) > 0 THEN
    UPDATE public.profiles
    SET credits = credits + v_generation.cost
    WHERE id = v_generation.user_id;

    GET DIAGNOSTICS v_profile_updates = ROW_COUNT;

    IF v_profile_updates <> 1 THEN
      RETURN jsonb_build_object(
        'status', 'profile_not_found',
        'generation_id', v_generation.id,
        'refunded', false
      );
    END IF;

    v_refunded := true;
  END IF;

  -- A blank or omitted reason must never erase one an earlier settlement
  -- attempt already recorded: replays of this RPC are expected (webhook
  -- redelivery, the completion cron) and the first attempt is the one that
  -- usually carries the provider's message.
  UPDATE public.generations
  SET status = 'failed',
      completed_at = coalesce(public.generations.completed_at, v_completed_at),
      error_message = coalesce(v_error_message, public.generations.error_message),
      refunded = CASE
        WHEN v_refunded THEN true
        ELSE coalesce(public.generations.refunded, false)
      END
  WHERE id = v_generation.id;

  RETURN jsonb_build_object(
    'status', 'failed',
    'generation_id', v_generation.id,
    'refunded', v_refunded OR coalesce(v_generation.refunded, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone, text) FROM anon;
REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_generation_failed(text, timestamp with time zone, text) TO service_role;

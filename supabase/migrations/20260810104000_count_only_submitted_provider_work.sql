-- Provider admission runs after the local generation/credit reservation is
-- created. Count only work that may actually exist at the provider; otherwise
-- a concurrent burst of local reservations can reject itself before any task
-- has been submitted.

CREATE OR REPLACE FUNCTION public.admit_provider_submission(
  p_service text,
  p_model text DEFAULT NULL,
  p_global_capacity numeric DEFAULT 15,
  p_global_refill_per_second numeric DEFAULT 1.5,
  p_model_capacity numeric DEFAULT NULL,
  p_model_refill_per_second numeric DEFAULT NULL,
  p_max_in_flight integer DEFAULT 50,
  p_in_flight_window_seconds integer DEFAULT 3600,
  p_circuit_open_seconds integer DEFAULT 60,
  p_probe_timeout_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_service text := btrim(coalesce(p_service, ''));
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_global_scope text;
  v_model_scope text;
  v_global_capacity numeric := greatest(coalesce(p_global_capacity, 15), 1);
  v_global_refill numeric := greatest(coalesce(p_global_refill_per_second, 1.5), 0.0001);
  v_model_capacity numeric := greatest(coalesce(p_model_capacity, 0), 0);
  v_model_refill numeric := greatest(coalesce(p_model_refill_per_second, 0), 0);
  v_max_in_flight integer := greatest(coalesce(p_max_in_flight, 50), 1);
  v_window_seconds integer := greatest(coalesce(p_in_flight_window_seconds, 3600), 60);
  v_open_seconds integer := greatest(coalesce(p_circuit_open_seconds, 60), 1);
  v_probe_timeout integer := greatest(coalesce(p_probe_timeout_seconds, 60), 1);
  v_breaker public.provider_circuit_breakers%ROWTYPE;
  v_in_flight integer;
  v_global_tokens numeric;
  v_model_tokens numeric;
  v_probe boolean := false;
BEGIN
  IF v_service = '' THEN
    RAISE EXCEPTION 'Provider admission service is required';
  END IF;

  v_global_scope := v_service;
  v_model_scope := CASE WHEN v_model IS NULL THEN NULL ELSE v_service || ':' || v_model END;

  INSERT INTO public.provider_circuit_breakers (service)
  VALUES (v_service)
  ON CONFLICT (service) DO NOTHING;

  SELECT * INTO v_breaker
  FROM public.provider_circuit_breakers
  WHERE service = v_service
  FOR UPDATE;

  IF v_breaker.state = 'open' THEN
    IF v_breaker.half_open_at IS NOT NULL AND now() >= v_breaker.half_open_at THEN
      v_probe := true;
      UPDATE public.provider_circuit_breakers
      SET state = 'half_open',
          probe_started_at = now(),
          updated_at = now()
      WHERE service = v_service;
    ELSE
      RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'circuit_open',
        'state', 'open',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
          coalesce(v_breaker.half_open_at, now()) - now()
        )))::integer),
        'inFlight', NULL
      );
    END IF;
  ELSIF v_breaker.state = 'half_open' THEN
    IF v_breaker.probe_started_at IS NOT NULL
       AND now() < v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'circuit_probe_in_flight',
        'state', 'half_open',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
          v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) - now()
        )))::integer),
        'inFlight', NULL
      );
    END IF;

    v_probe := true;
    UPDATE public.provider_circuit_breakers
    SET probe_started_at = now(), updated_at = now()
    WHERE service = v_service;
  END IF;

  IF v_probe THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', 'circuit_probe',
      'state', 'half_open',
      'retryAfterSeconds', 0,
      'inFlight', NULL
    );
  END IF;

  -- A plain pending row with neither identifier is only a local reservation.
  -- An attached prediction is confirmed provider work; submission_unknown is
  -- conservatively counted because the timed-out request may have been accepted.
  SELECT count(*) INTO v_in_flight
  FROM public.generations
  WHERE status IN ('pending', 'waiting', 'processing')
    AND (prediction_id IS NOT NULL OR submission_unknown_at IS NOT NULL)
    AND created_at > now() - make_interval(secs => v_window_seconds);

  IF v_in_flight >= v_max_in_flight THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'max_in_flight',
      'state', v_breaker.state,
      'retryAfterSeconds', 15,
      'inFlight', v_in_flight
    );
  END IF;

  INSERT INTO public.provider_admission_buckets (scope, tokens, updated_at)
  VALUES (v_global_scope, v_global_capacity, now())
  ON CONFLICT (scope) DO NOTHING;

  SELECT least(
    v_global_capacity,
    tokens + extract(epoch from (now() - updated_at)) * v_global_refill
  )
  INTO v_global_tokens
  FROM public.provider_admission_buckets
  WHERE scope = v_global_scope
  FOR UPDATE;

  IF v_model_scope IS NOT NULL AND v_model_capacity > 0 AND v_model_refill > 0 THEN
    INSERT INTO public.provider_admission_buckets (scope, tokens, updated_at)
    VALUES (v_model_scope, v_model_capacity, now())
    ON CONFLICT (scope) DO NOTHING;

    SELECT least(
      v_model_capacity,
      tokens + extract(epoch from (now() - updated_at)) * v_model_refill
    )
    INTO v_model_tokens
    FROM public.provider_admission_buckets
    WHERE scope = v_model_scope
    FOR UPDATE;
  END IF;

  IF v_global_tokens < 1 THEN
    UPDATE public.provider_admission_buckets
    SET tokens = v_global_tokens, updated_at = now()
    WHERE scope = v_global_scope;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'state', v_breaker.state,
      'retryAfterSeconds', greatest(
        1,
        ceil((1 - v_global_tokens) / v_global_refill)::integer
      ),
      'inFlight', v_in_flight
    );
  END IF;

  IF v_model_tokens IS NOT NULL AND v_model_tokens < 1 THEN
    UPDATE public.provider_admission_buckets
    SET tokens = v_model_tokens, updated_at = now()
    WHERE scope = v_model_scope;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'model_rate_limited',
      'state', v_breaker.state,
      'retryAfterSeconds', greatest(
        1,
        ceil((1 - v_model_tokens) / v_model_refill)::integer
      ),
      'inFlight', v_in_flight
    );
  END IF;

  UPDATE public.provider_admission_buckets
  SET tokens = v_global_tokens - 1, updated_at = now()
  WHERE scope = v_global_scope;

  IF v_model_tokens IS NOT NULL THEN
    UPDATE public.provider_admission_buckets
    SET tokens = v_model_tokens - 1, updated_at = now()
    WHERE scope = v_model_scope;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'admitted',
    'state', v_breaker.state,
    'retryAfterSeconds', 0,
    'inFlight', v_in_flight
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
) IS 'Atomically applies provider circuit, actual/ambiguous in-flight, and global/model token-bucket admission gates.';

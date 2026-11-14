-- Provider admission: a sliding rate window matched to Kie's published limit.
--
-- When the token buckets landed (20260809130000) Kie published no numeric
-- limit, so the bucket's burst and refill were our own guess. Kie now states
-- one (kie.ai/getting-started, section 8, read 2026-11-14): up to 20 new
-- generation requests per 10 seconds per account, rejected with a 429 and not
-- queued beyond that, and typically 100+ concurrently running tasks.
--
-- The buckets did not fit inside that. A bucket of 15 refilling at 1.5/s
-- admits 15 + 10 * 1.5 = 30 submissions in ten seconds after a quiet spell,
-- ten more than Kie accepts, and every one of those ten is a creator's start
-- that fails after its credits were held. Five in a row open the circuit for
-- everybody.
--
-- A bucket can only be made to fit by splitting one budget between burst and
-- rate: any capacity C and refill r must satisfy C + 10r <= 20, so a burst of
-- 10 leaves 1/s. The provider's rule is a count over a window, and the gate
-- that matches it is the same shape: at most p_rate_window_max admissions in
-- any p_rate_window_seconds. A window spends its whole count as a burst and
-- again every window after, and never admits one request more.
--
-- The app passes a window longer than Kie's (12 s against 10 s) and a count
-- below it (18 against 20): a burst of 18 where the bucket had 15, and the
-- same 1.5/s sustained. The longer window is the part that matters: we stamp
-- an admission before the request leaves, Kie counts it when it arrives, and
-- two bursts exactly one window apart on our clock can land closer than that
-- on Kie's. Two seconds of slack absorbs that; the two spare requests are for
-- the ones this gate does not count.
--
-- State: the admissions of the last window, as timestamps on the scope's row.
-- The array is bounded by the window's count, pruned on every admission, and
-- read under the row lock the buckets already took, so no new table, index or
-- sweep is needed.

ALTER TABLE public.provider_admission_buckets
  ADD COLUMN IF NOT EXISTS admitted_at timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[];

-- The token count has no reader once the functions below replace the bucket
-- arithmetic, and a NOT NULL column without a default would have to be written
-- on every seed for nothing.
ALTER TABLE public.provider_admission_buckets
  DROP COLUMN IF EXISTS tokens;

COMMENT ON TABLE public.provider_admission_buckets IS
  'Sliding rate windows for provider submission admission (F14). One row per scope: the service, and one per service+model.';
COMMENT ON COLUMN public.provider_admission_buckets.admitted_at IS
  'When each submission of the current rate window was admitted, oldest first. Pruned to the window on every admission.';

-- Both functions gain parameters, which is a new signature. The old ones are
-- dropped rather than left beside the new: two candidates that both accept the
-- old argument names make PostgREST refuse the call as ambiguous.
DROP FUNCTION IF EXISTS public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
);
DROP FUNCTION IF EXISTS public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer
);

-- The four bucket parameters stay in the signature, in their old positions,
-- and are ignored. Migrations reach production before the code that stops
-- sending them, and a rollback puts that older code back: its call must still
-- resolve to this function, because the app fails open on an RPC error and an
-- unresolvable call would leave the provider with no gate at all. Such a
-- caller gets the default window and no per-model share.
CREATE FUNCTION public.admit_provider_submission(
  p_service text,
  p_model text DEFAULT NULL,
  p_global_capacity numeric DEFAULT NULL,
  p_global_refill_per_second numeric DEFAULT NULL,
  p_model_capacity numeric DEFAULT NULL,
  p_model_refill_per_second numeric DEFAULT NULL,
  p_max_in_flight integer DEFAULT 50,
  p_in_flight_window_seconds integer DEFAULT 3600,
  p_circuit_open_seconds integer DEFAULT 60,
  p_probe_timeout_seconds integer DEFAULT 60,
  p_rate_window_seconds integer DEFAULT 12,
  p_rate_window_max integer DEFAULT 18,
  p_model_rate_window_max integer DEFAULT NULL
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
  v_max_in_flight integer := greatest(coalesce(p_max_in_flight, 50), 1);
  v_window_seconds integer := greatest(coalesce(p_in_flight_window_seconds, 3600), 60);
  v_probe_timeout integer := greatest(coalesce(p_probe_timeout_seconds, 60), 1);
  v_rate_window integer := greatest(coalesce(p_rate_window_seconds, 12), 1);
  v_rate_max integer := greatest(coalesce(p_rate_window_max, 18), 1);
  v_model_rate_max integer := greatest(coalesce(p_model_rate_window_max, 0), 0);
  v_breaker public.provider_circuit_breakers%ROWTYPE;
  v_in_flight integer;
  v_now timestamptz;
  v_cutoff timestamptz;
  v_global_admitted timestamptz[];
  v_model_admitted timestamptz[];
  v_global_recent timestamptz[];
  v_model_recent timestamptz[];
  v_probe boolean := false;
BEGIN
  IF v_service = '' THEN RAISE EXCEPTION 'Provider admission service is required'; END IF;
  v_global_scope := v_service;
  v_model_scope := CASE WHEN v_model IS NULL THEN NULL ELSE v_service || ':' || v_model END;

  INSERT INTO public.provider_circuit_breakers (service) VALUES (v_service)
  ON CONFLICT (service) DO NOTHING;
  SELECT * INTO v_breaker FROM public.provider_circuit_breakers
  WHERE service = v_service FOR UPDATE;

  IF v_breaker.state = 'open' THEN
    IF v_breaker.half_open_at IS NOT NULL AND now() >= v_breaker.half_open_at THEN
      v_probe := true;
      UPDATE public.provider_circuit_breakers
      SET state = 'half_open', probe_started_at = now(), updated_at = now()
      WHERE service = v_service;
    ELSE
      RETURN jsonb_build_object(
        'allowed', false, 'reason', 'circuit_open', 'state', 'open',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
          coalesce(v_breaker.half_open_at, now()) - now()
        )))::integer), 'inFlight', NULL
      );
    END IF;
  ELSIF v_breaker.state = 'half_open' THEN
    IF v_breaker.probe_started_at IS NOT NULL
       AND now() < v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) THEN
      RETURN jsonb_build_object(
        'allowed', false, 'reason', 'circuit_probe_in_flight', 'state', 'half_open',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
          v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) - now()
        )))::integer), 'inFlight', NULL
      );
    END IF;
    v_probe := true;
    UPDATE public.provider_circuit_breakers
    SET probe_started_at = now(), updated_at = now() WHERE service = v_service;
  END IF;

  -- Even a half-open probe consumes a durable capacity slot. It bypasses only
  -- the rate window, not the account's in-flight safety boundary.
  SELECT count(*) INTO v_in_flight
  FROM public.generations
  WHERE status IN ('pending', 'waiting', 'processing')
    AND (
      prediction_id IS NOT NULL
      OR submission_unknown_at IS NOT NULL
      OR provider_submission_reserved_at IS NOT NULL
    )
    AND created_at > now() - make_interval(secs => v_window_seconds);

  IF v_in_flight >= v_max_in_flight THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'max_in_flight', 'state', v_breaker.state,
      'retryAfterSeconds', 15, 'inFlight', v_in_flight
    );
  END IF;

  INSERT INTO public.provider_admission_buckets (scope) VALUES (v_global_scope)
  ON CONFLICT (scope) DO NOTHING;
  SELECT admitted_at INTO v_global_admitted FROM public.provider_admission_buckets
  WHERE scope = v_global_scope FOR UPDATE;

  -- A model's share is asked for only by a caller that names both the model
  -- and its share. Locked in the same order on every path (service row, then
  -- model row), so two admissions cannot wait on each other.
  IF NOT v_probe AND v_model_scope IS NOT NULL AND v_model_rate_max > 0 THEN
    INSERT INTO public.provider_admission_buckets (scope) VALUES (v_model_scope)
    ON CONFLICT (scope) DO NOTHING;
    SELECT admitted_at INTO v_model_admitted FROM public.provider_admission_buckets
    WHERE scope = v_model_scope FOR UPDATE;
  END IF;

  -- The wall clock, read after every lock this call waits on. now() is the
  -- transaction's start: an admission that queued behind others would be
  -- stamped earlier than it left, age out of the window early, and let one
  -- more request through than the window holds.
  v_now := clock_timestamp();
  v_cutoff := v_now - make_interval(secs => v_rate_window);

  SELECT coalesce(array_agg(admitted ORDER BY admitted), '{}'::timestamptz[])
  INTO v_global_recent
  FROM unnest(v_global_admitted) AS admitted
  WHERE admitted > v_cutoff;

  IF v_probe THEN
    -- The probe is not held to the window, or a full one could keep the
    -- breaker from ever closing. It is still a request the provider counts,
    -- so it is recorded for the admissions that follow a recovery.
    UPDATE public.provider_admission_buckets
    SET admitted_at = v_global_recent || v_now, updated_at = v_now
    WHERE scope = v_global_scope;

    RETURN jsonb_build_object(
      'allowed', true, 'reason', 'circuit_probe', 'state', 'half_open',
      'retryAfterSeconds', 0, 'inFlight', v_in_flight
    );
  END IF;

  IF v_model_admitted IS NOT NULL THEN
    SELECT coalesce(array_agg(admitted ORDER BY admitted), '{}'::timestamptz[])
    INTO v_model_recent
    FROM unnest(v_model_admitted) AS admitted
    WHERE admitted > v_cutoff;
  END IF;

  -- Both windows are read before either is written: an admission the model's
  -- share refuses must not take a place in the account's window. A refusal
  -- says when the admission that has to age out for a place to open does so.
  IF cardinality(v_global_recent) >= v_rate_max THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'rate_limited', 'state', v_breaker.state,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
        v_global_recent[cardinality(v_global_recent) - v_rate_max + 1]
          + make_interval(secs => v_rate_window) - v_now
      )))::integer),
      'inFlight', v_in_flight
    );
  END IF;

  IF v_model_recent IS NOT NULL AND cardinality(v_model_recent) >= v_model_rate_max THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'model_rate_limited', 'state', v_breaker.state,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
        v_model_recent[cardinality(v_model_recent) - v_model_rate_max + 1]
          + make_interval(secs => v_rate_window) - v_now
      )))::integer),
      'inFlight', v_in_flight
    );
  END IF;

  UPDATE public.provider_admission_buckets
  SET admitted_at = v_global_recent || v_now, updated_at = v_now
  WHERE scope = v_global_scope;
  IF v_model_recent IS NOT NULL THEN
    UPDATE public.provider_admission_buckets
    SET admitted_at = v_model_recent || v_now, updated_at = v_now
    WHERE scope = v_model_scope;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true, 'reason', 'admitted', 'state', v_breaker.state,
    'retryAfterSeconds', 0, 'inFlight', v_in_flight
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.admit_provider_submission(
  text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) IS 'Applies provider circuit, durable reservation/actual in-flight, and account/model sliding rate-window admission gates. The four bucket parameters are retired and ignored.';

CREATE FUNCTION public.reserve_provider_submission(
  p_generation_id uuid,
  p_service text,
  p_model text DEFAULT NULL,
  p_global_capacity numeric DEFAULT NULL,
  p_global_refill_per_second numeric DEFAULT NULL,
  p_model_capacity numeric DEFAULT NULL,
  p_model_refill_per_second numeric DEFAULT NULL,
  p_max_in_flight integer DEFAULT 50,
  p_in_flight_window_seconds integer DEFAULT 3600,
  p_circuit_open_seconds integer DEFAULT 60,
  p_probe_timeout_seconds integer DEFAULT 60,
  p_rate_window_seconds integer DEFAULT 12,
  p_rate_window_max integer DEFAULT 18,
  p_model_rate_window_max integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_verdict jsonb;
BEGIN
  IF p_generation_id IS NULL THEN
    RAISE EXCEPTION 'Generation id is required for provider capacity reservation';
  END IF;

  -- Serialise the count and reservation for this provider account. The
  -- breaker and window rows already serialise admissions, but the in-flight
  -- count and the reservation written below are not covered by either.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'provider-submission-reservation:' || btrim(coalesce(p_service, '')),
    0
  ));

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Generation % does not exist', p_generation_id;
  END IF;

  IF v_generation.status NOT IN ('pending', 'waiting', 'processing') THEN
    RAISE EXCEPTION 'Generation % is already terminal', p_generation_id;
  END IF;

  -- Retry-safe: a repeated app call for the same local generation owns the
  -- same slot instead of taking another place in the window or the capacity.
  IF v_generation.provider_submission_reserved_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', 'admitted',
      'state', 'reserved',
      'retryAfterSeconds', 0,
      'inFlight', NULL
    );
  END IF;

  v_verdict := public.admit_provider_submission(
    p_service => p_service,
    p_model => p_model,
    p_max_in_flight => p_max_in_flight,
    p_in_flight_window_seconds => p_in_flight_window_seconds,
    p_circuit_open_seconds => p_circuit_open_seconds,
    p_probe_timeout_seconds => p_probe_timeout_seconds,
    p_rate_window_seconds => p_rate_window_seconds,
    p_rate_window_max => p_rate_window_max,
    p_model_rate_window_max => p_model_rate_window_max
  );

  IF coalesce((v_verdict ->> 'allowed')::boolean, false) THEN
    UPDATE public.generations
    SET provider_submission_reserved_at = now()
    WHERE id = p_generation_id;
  END IF;

  RETURN v_verdict;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
) IS 'Atomically applies provider admission and reserves one durable in-flight slot for a local generation.';

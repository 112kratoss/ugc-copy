-- F14 part two: global provider admission control.
--
-- Kie admission was per-user only (30 per 10 min). Nothing bounded the
-- *account*: a launch spike, a template fan-out, or fifty users acting at once
-- all reach the provider unthrottled, and the first signal is a 429 storm on a
-- path where every rejected submission has already placed a credit hold.
--
-- Three gates land here, and they are one RPC rather than three because they
-- have to be decided together. Consuming a global token and then rejecting on
-- the per-model bucket leaks the global token; separate round trips also cost
-- three times the latency on the generation start path, which is already the
-- slowest thing a user waits on.
--
-- What this deliberately is NOT: a submission queue. The audit observes "a
-- launch spike hits provider 429s with no queue", but its prescribed fix is
-- admission control, and queueing a submission means holding the user's credits
-- against work that has not been sent -- F12's territory, and a much larger
-- change. A rejected submission here is refunded immediately by the settle
-- helper that already exists, which is correct precisely because no request was
-- ever sent to the provider, so nothing will be billed.

-- ─── Token buckets ───────────────────────────────────────────────────────────
--
-- A real bucket rather than reusing check_backend_rate_limit, which is a fixed
-- window. A fixed window at 15 per 10s admits 30 across a boundary instant,
-- which is the exact shape that trips a provider rate limit -- and since Kie
-- documents a 429 response but publishes no numeric limit or concurrency cap
-- (checked across all 20 model references), smoothing the burst is the only
-- protection available. The bucket's capacity is the burst we allow on purpose.

CREATE TABLE IF NOT EXISTS public.provider_admission_buckets (
  scope text PRIMARY KEY,
  tokens numeric(14,6) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_admission_buckets_scope_not_blank CHECK (btrim(scope) <> ''),
  CONSTRAINT provider_admission_buckets_tokens_nonnegative CHECK (tokens >= 0)
);

ALTER TABLE public.provider_admission_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_admission_buckets FROM PUBLIC;
REVOKE ALL ON public.provider_admission_buckets FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_admission_buckets TO service_role;

COMMENT ON TABLE public.provider_admission_buckets IS
  'Token buckets for provider submission admission (F14). One row per scope: the service, and one per service+model.';

-- ─── Circuit breaker ─────────────────────────────────────────────────────────
--
-- State must be shared across serverless instances, so it lives in Postgres
-- rather than in a module-level variable -- the same reason F12 moved workflow
-- run progress out of a process-local map. An in-memory breaker on Fluid
-- compute would trip per-instance and protect nothing.

CREATE TABLE IF NOT EXISTS public.provider_circuit_breakers (
  service text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed',
  consecutive_failures integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  -- When an open circuit is allowed to admit a single probe.
  half_open_at timestamptz,
  -- Set while a probe is in flight so concurrent callers cannot all probe at
  -- once and re-create the storm the breaker exists to stop.
  probe_started_at timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_circuit_breakers_service_not_blank CHECK (btrim(service) <> ''),
  CONSTRAINT provider_circuit_breakers_state_valid CHECK (state IN ('closed', 'open', 'half_open')),
  CONSTRAINT provider_circuit_breakers_failures_nonnegative CHECK (consecutive_failures >= 0)
);

ALTER TABLE public.provider_circuit_breakers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_circuit_breakers FROM PUBLIC;
REVOKE ALL ON public.provider_circuit_breakers FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_circuit_breakers TO service_role;

COMMENT ON TABLE public.provider_circuit_breakers IS
  'Cross-instance circuit breaker state per provider service (F14). Shared in Postgres because Fluid compute would trip a per-instance breaker independently.';

-- ─── Admission decision ──────────────────────────────────────────────────────

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
AS $$
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
  v_retry integer;
BEGIN
  IF v_service = '' THEN
    RAISE EXCEPTION 'Provider admission service is required';
  END IF;

  v_global_scope := v_service;
  v_model_scope := CASE WHEN v_model IS NULL THEN NULL ELSE v_service || ':' || v_model END;

  -- ── Gate 1: circuit breaker ────────────────────────────────────────────────
  -- Checked first and without consuming a token: when the provider is known to
  -- be failing, the cheapest correct answer is to decline before spending
  -- anything, and a token spent on a call we already expect to fail is a token
  -- unavailable to the recovery traffic after the breaker closes.
  INSERT INTO public.provider_circuit_breakers (service)
  VALUES (v_service)
  ON CONFLICT (service) DO NOTHING;

  SELECT * INTO v_breaker
  FROM public.provider_circuit_breakers
  WHERE service = v_service
  FOR UPDATE;

  IF v_breaker.state = 'open' THEN
    IF v_breaker.half_open_at IS NOT NULL AND now() >= v_breaker.half_open_at THEN
      -- Elapsed: promote to half-open and let *this* caller be the probe.
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
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (coalesce(v_breaker.half_open_at, now()) - now())))::integer),
        'inFlight', NULL
      );
    END IF;
  ELSIF v_breaker.state = 'half_open' THEN
    -- One probe at a time. A probe that never reported an outcome (a crashed
    -- instance) must not wedge the breaker shut forever, so a stale probe is
    -- reclaimed rather than trusted -- the same reasoning as F12's lease
    -- reclaim on coalesce(heartbeat_at, locked_at).
    IF v_breaker.probe_started_at IS NOT NULL
       AND now() < v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'circuit_probe_in_flight',
        'state', 'half_open',
        'retryAfterSeconds', greatest(1, ceil(extract(epoch from (
          v_breaker.probe_started_at + make_interval(secs => v_probe_timeout) - now())))::integer),
        'inFlight', NULL
      );
    END IF;

    v_probe := true;
    UPDATE public.provider_circuit_breakers
    SET probe_started_at = now(), updated_at = now()
    WHERE service = v_service;
  END IF;

  -- A probe deliberately skips the remaining gates. Its whole purpose is to
  -- discover whether the provider recovered, and a bucket that drained while
  -- the circuit was open would otherwise keep the probe from ever running --
  -- the breaker would never close.
  IF v_probe THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', 'circuit_probe',
      'state', 'half_open',
      'retryAfterSeconds', 0,
      'inFlight', NULL
    );
  END IF;

  -- ── Gate 2: in-flight concurrency ──────────────────────────────────────────
  -- Bounded by a recency window on purpose. Counting every non-terminal row
  -- would let a handful of permanently stuck generations wedge submissions for
  -- the whole account; the window keeps the gate reflecting live work, and the
  -- 45-minute stalled-generation reaper is what actually clears the strays.
  SELECT count(*) INTO v_in_flight
  FROM public.generations
  WHERE status IN ('pending', 'waiting', 'processing')
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

  -- ── Gate 3+4: token buckets, evaluated before either is consumed ───────────
  INSERT INTO public.provider_admission_buckets (scope, tokens, updated_at)
  VALUES (v_global_scope, v_global_capacity, now())
  ON CONFLICT (scope) DO NOTHING;

  SELECT least(v_global_capacity, tokens + extract(epoch from (now() - updated_at)) * v_global_refill)
  INTO v_global_tokens
  FROM public.provider_admission_buckets
  WHERE scope = v_global_scope
  FOR UPDATE;

  IF v_model_scope IS NOT NULL AND v_model_capacity > 0 AND v_model_refill > 0 THEN
    INSERT INTO public.provider_admission_buckets (scope, tokens, updated_at)
    VALUES (v_model_scope, v_model_capacity, now())
    ON CONFLICT (scope) DO NOTHING;

    SELECT least(v_model_capacity, tokens + extract(epoch from (now() - updated_at)) * v_model_refill)
    INTO v_model_tokens
    FROM public.provider_admission_buckets
    WHERE scope = v_model_scope
    FOR UPDATE;
  END IF;

  IF v_global_tokens < 1 THEN
    -- Persist the refill even on rejection, so the next caller does not
    -- recompute elapsed time from a stale stamp.
    UPDATE public.provider_admission_buckets
    SET tokens = v_global_tokens, updated_at = now()
    WHERE scope = v_global_scope;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate_limited',
      'state', v_breaker.state,
      'retryAfterSeconds', greatest(1, ceil((1 - v_global_tokens) / v_global_refill)::integer),
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
      'retryAfterSeconds', greatest(1, ceil((1 - v_model_tokens) / v_model_refill)::integer),
      'inFlight', v_in_flight
    );
  END IF;

  -- Both buckets can pay: consume together.
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
$$;

REVOKE ALL ON FUNCTION public.admit_provider_submission(text, text, numeric, numeric, numeric, numeric, integer, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_provider_submission(text, text, numeric, numeric, numeric, numeric, integer, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.admit_provider_submission(text, text, numeric, numeric, numeric, numeric, integer, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admit_provider_submission(text, text, numeric, numeric, numeric, numeric, integer, integer, integer, integer) TO service_role;

-- ─── Outcome reporting ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_provider_submission_outcome(
  p_service text,
  p_success boolean,
  p_failure_threshold integer DEFAULT 5,
  p_circuit_open_seconds integer DEFAULT 60,
  p_retry_after_seconds integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_service text := btrim(coalesce(p_service, ''));
  v_threshold integer := greatest(coalesce(p_failure_threshold, 5), 1);
  v_open_seconds integer := greatest(coalesce(p_circuit_open_seconds, 60), 1);
  v_retry_after integer := greatest(coalesce(p_retry_after_seconds, 0), 0);
  v_breaker public.provider_circuit_breakers%ROWTYPE;
  v_failures integer;
  v_state text;
  v_open_for integer;
BEGIN
  IF v_service = '' THEN
    RAISE EXCEPTION 'Provider admission service is required';
  END IF;

  INSERT INTO public.provider_circuit_breakers (service)
  VALUES (v_service)
  ON CONFLICT (service) DO NOTHING;

  SELECT * INTO v_breaker
  FROM public.provider_circuit_breakers
  WHERE service = v_service
  FOR UPDATE;

  IF p_success THEN
    -- Any success closes the circuit outright rather than decrementing. A
    -- half-open probe that succeeds is the definition of recovered, and a
    -- gradual climb-down would keep rejecting real traffic after the provider
    -- is demonstrably healthy.
    UPDATE public.provider_circuit_breakers
    SET state = 'closed',
        consecutive_failures = 0,
        opened_at = NULL,
        half_open_at = NULL,
        probe_started_at = NULL,
        last_success_at = now(),
        updated_at = now()
    WHERE service = v_service;

    RETURN jsonb_build_object('state', 'closed', 'consecutiveFailures', 0);
  END IF;

  v_failures := coalesce(v_breaker.consecutive_failures, 0) + 1;

  -- A failed probe re-opens immediately: it already proved the provider is
  -- still failing, so making it serve out another threshold's worth of real
  -- user requests to re-learn that would be the storm we are preventing.
  IF v_failures >= v_threshold OR v_breaker.state = 'half_open' THEN
    -- Honour the provider's own Retry-After when it is longer than our backoff.
    -- It is the only authoritative statement about when the provider will
    -- accept traffic again, and Kie publishes no limits anywhere else.
    v_open_for := greatest(v_open_seconds, v_retry_after);
    v_state := 'open';

    UPDATE public.provider_circuit_breakers
    SET state = 'open',
        consecutive_failures = v_failures,
        opened_at = coalesce(v_breaker.opened_at, now()),
        half_open_at = now() + make_interval(secs => v_open_for),
        probe_started_at = NULL,
        last_failure_at = now(),
        updated_at = now()
    WHERE service = v_service;
  ELSE
    v_state := 'closed';
    UPDATE public.provider_circuit_breakers
    SET consecutive_failures = v_failures,
        last_failure_at = now(),
        probe_started_at = NULL,
        updated_at = now()
    WHERE service = v_service;
  END IF;

  RETURN jsonb_build_object(
    'state', v_state,
    'consecutiveFailures', v_failures,
    'openForSeconds', coalesce(v_open_for, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_submission_outcome(text, boolean, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_provider_submission_outcome(text, boolean, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.record_provider_submission_outcome(text, boolean, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_submission_outcome(text, boolean, integer, integer, integer) TO service_role;

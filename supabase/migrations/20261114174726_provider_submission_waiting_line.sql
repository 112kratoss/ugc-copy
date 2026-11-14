-- Provider admission: a waiting line, so a start over the limit waits its turn.
--
-- Until now a start the gate refused (the rate window full, a model at its
-- share, fifty tasks running) was failed and refunded on the spot, and the
-- creator pressed Generate again. The limits it meets clear by themselves in
-- seconds: a place in the rate window opens within twelve, and with fifty tasks
-- running one finishes every few seconds. The app now asks again until it is
-- admitted or its wait runs out, and this migration makes that waiting fair.
--
-- Asking again is not a queue by itself: whoever asks first after a place opens
-- takes it, so a start that arrives at the right moment passes one that has
-- waited ten seconds, and under load the oldest can wait out their time while
-- newcomers go through. The line fixes the order. A waiting start holds a
-- ticket stamped when it was first refused; a start is admitted only when
-- there is a place for it and one for every live ticket older than its own. A
-- start that has no ticket yet is behind every ticket.
--
-- A ticket is alive while its start keeps asking (`seen_at` within the TTL)
-- and its generation is still waiting to be sent. A request that died stops
-- asking and drops out of the line by itself; one that gave up was settled as
-- failed, which takes it out at once.
--
-- What this is not: a queue that outlives the request. The start's own request
-- waits, holding its credits, and gives up with a refund when its time is up.
-- Template and workflow steps keep their own durable retry and do not wait
-- here; they are still held behind the line, so they cannot pass a creator who
-- is waiting.

CREATE TABLE IF NOT EXISTS public.provider_submission_waiters (
  generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
  service text NOT NULL,
  model text,
  -- The ticket: when this start was first refused. Never moved by a later ask.
  waiting_since timestamptz NOT NULL,
  -- The heartbeat: when this start last asked.
  seen_at timestamptz NOT NULL,
  -- What the last ask was refused for. A start waiting on its model's share is
  -- not in line for an account place, and must not hold one against others.
  reason text NOT NULL,
  CONSTRAINT provider_submission_waiters_service_not_blank CHECK (btrim(service) <> ''),
  CONSTRAINT provider_submission_waiters_reason_valid
    CHECK (reason IN ('rate_limited', 'model_rate_limited', 'max_in_flight'))
);

CREATE INDEX IF NOT EXISTS provider_submission_waiters_line_idx
  ON public.provider_submission_waiters (service, waiting_since);

ALTER TABLE public.provider_submission_waiters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_submission_waiters FROM PUBLIC;
REVOKE ALL ON public.provider_submission_waiters FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_submission_waiters TO service_role;

COMMENT ON TABLE public.provider_submission_waiters IS
  'The line of generation starts waiting for provider admission. One row per waiting start, removed when it is admitted; rows whose start stopped asking are pruned by the next reservation.';

-- The reservation gains two parameters, which is a new signature; the old one
-- is dropped so PostgREST has a single candidate. A call from the deployment
-- before this migration names neither and resolves here with the defaults: it
-- does not wait, and it is held behind the line like any other newcomer.
DROP FUNCTION IF EXISTS public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer
);

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
  p_model_rate_window_max integer DEFAULT NULL,
  p_wait boolean DEFAULT false,
  p_waiter_ttl_seconds integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_service text := btrim(coalesce(p_service, ''));
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_max_in_flight integer := greatest(coalesce(p_max_in_flight, 50), 1);
  v_rate_window integer := greatest(coalesce(p_rate_window_seconds, 12), 1);
  v_rate_max integer := greatest(coalesce(p_rate_window_max, 18), 1);
  v_model_rate_max integer := greatest(coalesce(p_model_rate_window_max, 0), 0);
  v_ttl integer := greatest(coalesce(p_waiter_ttl_seconds, 15), 1);
  v_wait boolean := coalesce(p_wait, false);
  v_generation public.generations%ROWTYPE;
  v_breaker_state text;
  v_now timestamptz;
  v_ticket timestamptz;
  v_ahead integer := 0;
  v_model_ahead integer := 0;
  v_reason text;
  v_verdict jsonb;
BEGIN
  IF p_generation_id IS NULL THEN
    RAISE EXCEPTION 'Generation id is required for provider capacity reservation';
  END IF;

  -- Serialise the count, the line and the reservation for this provider
  -- account. The breaker and window rows already serialise admissions, but the
  -- in-flight count, the tickets read below and the reservation written at the
  -- end are not covered by either.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'provider-submission-reservation:' || v_service,
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
    DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', 'admitted',
      'state', 'reserved',
      'retryAfterSeconds', 0,
      'inFlight', NULL
    );
  END IF;

  -- Read after the locks above, like the window's own stamps: a call that
  -- queued behind others must not be given a ticket older than its first ask.
  v_now := clock_timestamp();

  -- Tickets whose start stopped asking long ago. They already count for
  -- nothing (the TTL below); this keeps the table the size of the line.
  DELETE FROM public.provider_submission_waiters
  WHERE service = v_service
    AND seen_at < v_now - make_interval(secs => greatest(v_ttl * 4, 60));

  SELECT waiting_since INTO v_ticket
  FROM public.provider_submission_waiters
  WHERE generation_id = p_generation_id;

  SELECT state INTO v_breaker_state
  FROM public.provider_circuit_breakers
  WHERE service = v_service;

  -- The line orders starts that are waiting on capacity. While the circuit is
  -- open nobody is admitted but the probe, so the admission below answers for
  -- the breaker alone and the line is left out of it.
  IF coalesce(v_breaker_state, 'closed') = 'closed' THEN
    -- Live tickets ahead of this start: every one of them when it has no
    -- ticket yet, the older ones when it has. A ticket is alive while its
    -- start keeps asking and its generation is still waiting to be sent.
    SELECT
      count(*) FILTER (WHERE w.reason <> 'model_rate_limited'),
      count(*) FILTER (WHERE v_model IS NOT NULL AND w.model = v_model)
    INTO v_ahead, v_model_ahead
    FROM public.provider_submission_waiters w
    JOIN public.generations g ON g.id = w.generation_id
    WHERE w.service = v_service
      AND w.generation_id <> p_generation_id
      AND w.seen_at > v_now - make_interval(secs => v_ttl)
      AND (
        v_ticket IS NULL
        OR w.waiting_since < v_ticket
        OR (w.waiting_since = v_ticket AND w.generation_id < p_generation_id)
      )
      AND g.status = 'pending'
      AND g.prediction_id IS NULL
      AND g.provider_submission_reserved_at IS NULL;

    -- More starts ahead than the limit holds at all: no admission could leave
    -- a place for each of them and one for this start.
    IF v_ahead >= v_max_in_flight THEN
      v_reason := 'max_in_flight';
    ELSIF v_ahead >= v_rate_max THEN
      v_reason := 'rate_limited';
    ELSIF v_model IS NOT NULL AND v_model_rate_max > 0 AND v_model_ahead >= v_model_rate_max THEN
      v_reason := 'model_rate_limited';
    END IF;

    IF v_reason IS NOT NULL THEN
      v_verdict := jsonb_build_object(
        'allowed', false, 'reason', v_reason, 'state', 'closed',
        'retryAfterSeconds', CASE WHEN v_reason = 'max_in_flight' THEN 15 ELSE v_rate_window END,
        'inFlight', NULL
      );
    END IF;
  END IF;

  IF v_verdict IS NULL THEN
    -- A place for this start and one for each start ahead of it: the limits
    -- are asked for with the places the line holds taken off. Those ahead that
    -- wait on their model's share are not in line for an account place.
    v_verdict := public.admit_provider_submission(
      p_service => p_service,
      p_model => p_model,
      p_max_in_flight => v_max_in_flight - v_ahead,
      p_in_flight_window_seconds => p_in_flight_window_seconds,
      p_circuit_open_seconds => p_circuit_open_seconds,
      p_probe_timeout_seconds => p_probe_timeout_seconds,
      p_rate_window_seconds => p_rate_window_seconds,
      p_rate_window_max => v_rate_max - v_ahead,
      p_model_rate_window_max => CASE
        WHEN v_model_rate_max > 0 THEN v_model_rate_max - v_model_ahead
        ELSE NULL
      END
    );
  END IF;

  v_reason := v_verdict ->> 'reason';

  IF coalesce((v_verdict ->> 'allowed')::boolean, false) THEN
    UPDATE public.generations
    SET provider_submission_reserved_at = now()
    WHERE id = p_generation_id;

    DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;

    RETURN v_verdict || jsonb_build_object('waiting', false, 'waitersAhead', v_ahead);
  END IF;

  IF v_wait AND v_reason IN ('rate_limited', 'model_rate_limited', 'max_in_flight') THEN
    -- Take a ticket, or keep the one it has: the stamp is the first refusal's.
    INSERT INTO public.provider_submission_waiters AS w
      (generation_id, service, model, waiting_since, seen_at, reason)
    VALUES (p_generation_id, v_service, v_model, v_now, v_now, v_reason)
    ON CONFLICT (generation_id) DO UPDATE
      SET seen_at = excluded.seen_at, reason = excluded.reason, model = excluded.model;

    RETURN v_verdict || jsonb_build_object('waiting', true, 'waitersAhead', v_ahead);
  END IF;

  -- Not waiting, or refused for the breaker: nothing to wait in line for.
  DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;

  RETURN v_verdict || jsonb_build_object('waiting', false, 'waitersAhead', v_ahead);
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer, boolean, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer, boolean, integer
) TO service_role;

COMMENT ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer, boolean, integer
) IS 'Atomically applies provider admission behind the waiting line and reserves one durable in-flight slot for a local generation. With p_wait, a start refused for capacity takes or keeps its ticket in the line.';

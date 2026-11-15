-- A background queue for generation starts over the provider's limits.
--
-- The waiting line (20261114174726) made a start over the limits wait its turn,
-- but inside its own request: about 45 seconds, behind a spinner, and a longer
-- line still failed. A start now answers at once as queued, and the server
-- sends it when its turn comes, whether or not the creator is still there.
--
-- What makes that possible is keeping the one thing that used to live only in
-- the request's memory: the prepared provider request. It is stored here from
-- the moment the gate refuses the start until the moment something sends it.
--
-- Sending is guarded by the claim. Several things may try to send a queued run
-- (the request that queued it, working on after it answered; the creator's
-- status checks; the provider's callback for a finished task; a cron), and the
-- one that deletes this row is the only one holding the request. A run is
-- therefore sent once, or refunded once, and never both.
--
-- The request is the creator's material: signed links to their inputs and, for
-- a private recipe, the prompt, which is deliberately not kept on the
-- generation row. It is readable by the service role alone, and it exists only
-- while its generation is still waiting to be sent: a claim deletes it, and so
-- does the generation leaving `pending` by any other road (the trigger below).
-- A run may stay queued ten minutes; the pass that finds one older ends it, so
-- a row nothing is driving lasts until the next pass, the cron's at the latest.
--
-- The order is the queue's own: reserve_provider_submission counts the rows
-- queued before a caller as the line ahead of it, whether or not anything is
-- asking for them.

CREATE TABLE IF NOT EXISTS public.generation_queued_submissions (
  generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  service text NOT NULL,
  model text,
  endpoint text NOT NULL,
  request jsonb NOT NULL,
  queued_at timestamptz NOT NULL,
  CONSTRAINT generation_queued_submissions_service_not_blank CHECK (btrim(service) <> ''),
  CONSTRAINT generation_queued_submissions_endpoint_not_blank CHECK (btrim(endpoint) <> ''),
  CONSTRAINT generation_queued_submissions_request_is_object CHECK (jsonb_typeof(request) = 'object')
);

CREATE INDEX IF NOT EXISTS generation_queued_submissions_line_idx
  ON public.generation_queued_submissions (service, queued_at);

CREATE INDEX IF NOT EXISTS generation_queued_submissions_user_idx
  ON public.generation_queued_submissions (user_id);

ALTER TABLE public.generation_queued_submissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.generation_queued_submissions FROM PUBLIC;
REVOKE ALL ON public.generation_queued_submissions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_queued_submissions TO service_role;

COMMENT ON TABLE public.generation_queued_submissions IS
  'Generation starts waiting to be sent to the provider, with the request to send. One row per queued run, deleted by whatever claims it to send, cancel or expire it.';
COMMENT ON COLUMN public.generation_queued_submissions.request IS
  'The prepared provider request, as it would have been sent. Holds signed input links and, for a private recipe, the prompt: service role only, and gone once claimed.';

-- ─── Queueing ────────────────────────────────────────────────────────────────
--
-- Called after the reservation refused the start for capacity. Takes the same
-- advisory lock as the reservation, so the queue's length is counted against
-- a line that is not moving.

CREATE FUNCTION public.enqueue_provider_submission(
  p_generation_id uuid,
  p_service text,
  p_model text,
  p_endpoint text,
  p_request jsonb,
  p_queue_max integer DEFAULT 200,
  p_user_queue_max integer DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_service text := btrim(coalesce(p_service, ''));
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_queue_max integer := greatest(coalesce(p_queue_max, 200), 1);
  v_user_queue_max integer := greatest(coalesce(p_user_queue_max, 4), 1);
  v_generation public.generations%ROWTYPE;
  v_queued_at timestamptz;
  v_total integer;
  v_of_user integer;
BEGIN
  IF p_generation_id IS NULL OR v_service = '' OR v_endpoint = ''
     OR p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'provider-submission-reservation:' || v_service,
    0
  ));

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  -- Only a start that holds its credits and has reached nothing may queue. One
  -- that is reserved, attached or marked unknown is already on its way.
  IF v_generation.status <> 'pending'
     OR v_generation.prediction_id IS NOT NULL
     OR v_generation.provider_submission_reserved_at IS NOT NULL
     OR v_generation.submission_unknown_at IS NOT NULL THEN
    DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;
    -- `onItsWay` tells a caller asking again after a lost answer what became
    -- of the start: with a task, or settled, it was queued and has been sent.
    -- Reserved alone says nothing: the reservation may be the start's own.
    RETURN jsonb_build_object(
      'status', 'not_queueable',
      'onItsWay', v_generation.prediction_id IS NOT NULL OR v_generation.status <> 'pending'
    );
  END IF;

  -- A repeated call keeps the place and the request it already has.
  SELECT queued_at INTO v_queued_at
  FROM public.generation_queued_submissions
  WHERE generation_id = p_generation_id;

  IF FOUND THEN
    RETURN jsonb_build_object('status', 'queued', 'queuedAt', v_queued_at, 'replayed', true);
  END IF;

  -- Rows whose run was settled or sent by something that did not claim them
  -- (the reaper, a provider callback). They hold no place.
  DELETE FROM public.generation_queued_submissions q
  USING public.generations g
  WHERE q.service = v_service
    AND g.id = q.generation_id
    AND (g.status <> 'pending' OR g.prediction_id IS NOT NULL);

  SELECT count(*), count(*) FILTER (WHERE user_id = v_generation.user_id)
  INTO v_total, v_of_user
  FROM public.generation_queued_submissions
  WHERE service = v_service;

  IF v_total >= v_queue_max OR v_of_user >= v_user_queue_max THEN
    -- Refused: the caller fails and refunds the start, and it must not go on
    -- holding a place in the line.
    DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;
    RETURN jsonb_build_object(
      'status', CASE WHEN v_total >= v_queue_max THEN 'queue_full' ELSE 'user_queue_full' END,
      'queued', v_total,
      'queuedOfUser', v_of_user
    );
  END IF;

  v_queued_at := clock_timestamp();

  INSERT INTO public.generation_queued_submissions
    (generation_id, user_id, service, model, endpoint, request, queued_at)
  VALUES
    (p_generation_id, v_generation.user_id, v_service, v_model, v_endpoint, p_request, v_queued_at);

  RETURN jsonb_build_object('status', 'queued', 'queuedAt', v_queued_at, 'ahead', v_total);
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_provider_submission(uuid, text, text, text, jsonb, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_provider_submission(uuid, text, text, text, jsonb, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.enqueue_provider_submission(uuid, text, text, text, jsonb, integer, integer) IS
  'Queues a generation start the reservation refused for capacity, with the provider request to send later. Refuses when the queue or the creator''s share of it is full.';

-- ─── Claiming ────────────────────────────────────────────────────────────────
--
-- The one way a queued request leaves the table. Whoever gets it back is the
-- only caller that may send, cancel or expire the run; everyone else gets null.

CREATE FUNCTION public.claim_queued_provider_submission(p_generation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_claim jsonb;
  v_sendable boolean;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN NULL;
  END IF;

  DELETE FROM public.generation_queued_submissions
  WHERE generation_id = p_generation_id
  RETURNING jsonb_build_object(
    'generationId', generation_id,
    'userId', user_id,
    'service', service,
    'model', model,
    'endpoint', endpoint,
    'request', request,
    'queuedAt', queued_at
  ) INTO v_claim;

  -- Sent, cancelled or expired, it waits in line no longer.
  DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;

  IF v_claim IS NULL THEN
    RETURN NULL;
  END IF;

  -- The request is the caller's now, but only a generation that still holds
  -- its credits and has reached nothing may be sent with it. One that was
  -- settled, attached or marked unknown while its row waited must not be: its
  -- hold is gone or spoken for, and a send would run a task nobody pays for.
  SELECT g.status = 'pending'
     AND g.prediction_id IS NULL
     AND g.submission_unknown_at IS NULL
  INTO v_sendable
  FROM public.generations g
  WHERE g.id = p_generation_id;

  RETURN v_claim || jsonb_build_object('sendable', coalesce(v_sendable, false));
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_queued_provider_submission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_queued_provider_submission(uuid) TO service_role;

COMMENT ON FUNCTION public.claim_queued_provider_submission(uuid) IS
  'Atomically takes a queued generation''s stored provider request out of the queue. Returns it to exactly one caller, with whether the generation may still be sent; null to every other.';

-- ─── A queued request never outlives its wait ────────────────────────────────
--
-- A generation can leave `pending` without its queue row being claimed: the
-- start that queued it failed after the row was written, the reaper ended it,
-- a callback attached a task. The row would then hold the creator's request
-- (signed links, a private prompt) for nothing, and a pass over the queue
-- would find a run to send whose credits had already been returned. The row
-- goes with the status, in the same transaction.

CREATE FUNCTION public.drop_queued_submission_of_settled_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  DELETE FROM public.generation_queued_submissions WHERE generation_id = NEW.id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.drop_queued_submission_of_settled_generation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drop_queued_submission_of_settled_generation() TO service_role;

COMMENT ON FUNCTION public.drop_queued_submission_of_settled_generation() IS
  'Trigger: deletes a generation''s queued provider request when the generation leaves pending.';

DROP TRIGGER IF EXISTS generations_drop_queued_submission ON public.generations;
CREATE TRIGGER generations_drop_queued_submission
  AFTER UPDATE OF status ON public.generations
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status IS DISTINCT FROM 'pending')
  EXECUTE FUNCTION public.drop_queued_submission_of_settled_generation();

-- ─── The line ────────────────────────────────────────────────────────────────
--
-- The reservation's signature and grants are unchanged, so the deployed code's
-- call resolves to it as before. What changes is who is in the line. Until now
-- that was the tickets of starts waiting inside their requests, alive only
-- while each kept asking. A queued start waits with nothing asking for it, so
-- the queue's own rows are counted too. With an empty queue this is the
-- function it replaces.

CREATE OR REPLACE FUNCTION public.reserve_provider_submission(
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
  p_waiter_ttl_seconds integer DEFAULT 15,
  p_turn_since timestamptz DEFAULT NULL,
  p_line_max integer DEFAULT NULL,
  p_model_line_max integer DEFAULT NULL
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
  v_ticket_seen timestamptz;
  v_ticket_live boolean := false;
  v_queued_at timestamptz;
  v_queue_ahead integer := 0;
  v_queue_model_ahead integer := 0;
  v_turn timestamptz;
  v_line integer := 0;
  v_model_line integer := 0;
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

  SELECT waiting_since, seen_at INTO v_ticket, v_ticket_seen
  FROM public.provider_submission_waiters
  WHERE generation_id = p_generation_id;

  -- A ticket this start let lapse (it asked too slowly) still dates its turn,
  -- but it has not been counted in the line since, so it is not owed a place
  -- in a line that filled up meanwhile.
  v_ticket_live := v_ticket IS NOT NULL AND v_ticket_seen > v_now - make_interval(secs => v_ttl);

  SELECT queued_at INTO v_queued_at
  FROM public.generation_queued_submissions
  WHERE generation_id = p_generation_id;

  -- This start's turn: its ticket; or when it was queued, read from its own
  -- row so no caller has to say; or for a run step, which keeps neither, the
  -- moment it says it was first turned away, never later than now. With none
  -- of them it is behind every ticket and every queued start.
  v_turn := coalesce(
    v_ticket,
    v_queued_at,
    CASE WHEN p_turn_since IS NULL THEN NULL ELSE least(p_turn_since, v_now) END
  );

  -- Read without the row's lock: the advisory lock above already puts this
  -- reservation after the ones before it, and the admission below locks the
  -- breaker itself before it decides anything.
  SELECT state INTO v_breaker_state
  FROM public.provider_circuit_breakers
  WHERE service = v_service;

  -- The line orders starts that are waiting on capacity. While the circuit is
  -- open nobody is admitted but the probe, so the admission below answers for
  -- the breaker alone and the line is left out of it.
  IF coalesce(v_breaker_state, 'closed') = 'closed' THEN
    -- Live tickets ahead of this start: every one of them when it has no
    -- turn yet, the older ones when it has. A ticket is alive while its start
    -- keeps asking and its generation is still waiting to be sent.
    --
    -- A ticket's reason is what its last ask was refused for, so it can be one
    -- ask out of date: a start whose model has since freed up is not counted
    -- for an account place until it asks again, and one it was counted for may
    -- by then be its model's to wait on. Either way the next ask puts it right,
    -- and the limits themselves are the admission's, which no count here can
    -- raise.
    --
    -- The line's length is counted whole, not only ahead of this start: it is
    -- what a start without a live ticket is held to before it may join.
    SELECT
      count(*),
      count(*) FILTER (WHERE v_model IS NOT NULL AND live.model = v_model),
      count(*) FILTER (WHERE live.ahead AND live.reason <> 'model_rate_limited'),
      count(*) FILTER (WHERE live.ahead AND v_model IS NOT NULL AND live.model = v_model)
    INTO v_line, v_model_line, v_ahead, v_model_ahead
    FROM (
      SELECT
        w.model,
        w.reason,
        (
          v_turn IS NULL
          OR w.waiting_since < v_turn
          OR (w.waiting_since = v_turn AND w.generation_id < p_generation_id)
        ) AS ahead
      FROM public.provider_submission_waiters w
      JOIN public.generations g ON g.id = w.generation_id
      WHERE w.service = v_service
        AND w.generation_id <> p_generation_id
        AND w.seen_at > v_now - make_interval(secs => v_ttl)
        AND g.status = 'pending'
        AND g.prediction_id IS NULL
        AND g.provider_submission_reserved_at IS NULL
    ) AS live;

    -- Queued starts ahead of this one. A queued start has no heartbeat to
    -- lapse: it is in the line for as long as its row is in the queue and its
    -- generation is still waiting to be sent, whether or not anything is asking
    -- for it just now. That is what makes the queue's order the order it was
    -- joined in, and what stops a new start walking past a queue nobody
    -- happens to be driving.
    --
    -- Not every queued start ahead can take an account place this window: one
    -- model's are held to that model's share. Counting them all would park
    -- another model's starts behind a single model's backlog, with the places
    -- kept for them standing empty. Each model's queued starts count for the
    -- places its share still has, and no more.
    SELECT
      coalesce(sum(least(
        queued.starts,
        CASE
          WHEN v_model_rate_max > 0 AND queued.model IS NOT NULL
            THEN greatest(v_model_rate_max - queued.taken, 0)
          ELSE queued.starts
        END
      )), 0),
      coalesce(sum(queued.starts) FILTER (WHERE v_model IS NOT NULL AND queued.model = v_model), 0)
    INTO v_queue_ahead, v_queue_model_ahead
    FROM (
      SELECT
        s.model,
        count(*)::integer AS starts,
        (
          SELECT count(*)::integer
          FROM public.provider_admission_buckets b, unnest(b.admitted_at) AS admitted
          WHERE b.scope = v_service || ':' || s.model
            AND admitted > v_now - make_interval(secs => v_rate_window)
        ) AS taken
      FROM public.generation_queued_submissions s
      JOIN public.generations g ON g.id = s.generation_id
      WHERE s.service = v_service
        AND s.generation_id <> p_generation_id
        AND (
          v_turn IS NULL
          OR s.queued_at < v_turn
          OR (s.queued_at = v_turn AND s.generation_id < p_generation_id)
        )
        AND g.status = 'pending'
        AND g.prediction_id IS NULL
        AND g.provider_submission_reserved_at IS NULL
        -- A run queued longer than this is past its ten minutes (the app's
        -- queueMaxAgeMs) and is only waiting for the pass that ends it. It is
        -- owed no place. Without this bound, rows that nothing drives (the
        -- code rolled back to a deployment that knows no queue) would stand
        -- ahead of every start until the reaper ended them 45 minutes on.
        AND s.queued_at > v_now - interval '15 minutes'
      GROUP BY s.model
    ) AS queued;

    v_ahead := v_ahead + v_queue_ahead;
    v_model_ahead := v_model_ahead + v_queue_model_ahead;

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

  IF v_wait AND v_reason IN ('rate_limited', 'model_rate_limited', 'max_in_flight')
     -- The line is full for a start that is not in it yet. One that holds a
     -- live ticket keeps it: it was let in, and is nearer the front every ask.
     AND (
       v_ticket_live
       OR (
         (p_line_max IS NULL OR v_line < p_line_max)
         AND (p_model_line_max IS NULL OR v_model IS NULL OR v_model_line < p_model_line_max)
       )
     ) THEN
    -- Take a ticket, or keep the one it has: the stamp is the first refusal's.
    INSERT INTO public.provider_submission_waiters AS w
      (generation_id, service, model, waiting_since, seen_at, reason)
    VALUES (p_generation_id, v_service, v_model, v_now, v_now, v_reason)
    ON CONFLICT (generation_id) DO UPDATE
      SET seen_at = excluded.seen_at, reason = excluded.reason, model = excluded.model;

    RETURN v_verdict || jsonb_build_object('waiting', true, 'waitersAhead', v_ahead);
  END IF;

  -- Not waiting, refused for the breaker, or the line is full: no ticket.
  DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;

  RETURN v_verdict || jsonb_build_object('waiting', false, 'waitersAhead', v_ahead);
END;
$function$;


COMMENT ON FUNCTION public.reserve_provider_submission(
  uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer, boolean, integer,
  timestamptz, integer, integer
) IS 'Atomically applies provider admission behind the line and reserves one durable in-flight slot for a local generation. The line is the queue of starts waiting to be sent, in the order they were queued, and the tickets of starts still waiting inside their requests. p_turn_since is the turn of a run step, which keeps neither.';

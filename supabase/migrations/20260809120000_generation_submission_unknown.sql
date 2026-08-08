-- F14 part two: hold ambiguous provider submissions instead of refunding them.
--
-- `createKieTask` times out at 30s with no retry, and the catch in every start
-- path refunds on `!predictionId`. That branch cannot tell a timeout from a
-- definitive provider rejection, so when Kie has in fact accepted the task the
-- app refunds, then discards the callback that arrives for a generation it has
-- already settled as failed. The money is lost twice: once on the refund, and
-- again on the output the provider will still bill for.
--
-- The fix is a state plus a grace period, not a new mechanism. The ambiguous
-- case is marked and left held; the two ways out of that state already exist:
--
--   * the callback lands -> `attach_generation_provider_task` sees a pending row
--     with no task and attaches normally, rescuing the generation;
--   * the callback never lands -> `reapStalledGenerations` already selects
--     exactly this shape (`pending`, no prediction_id, older than 45 minutes)
--     and settles it through `settle_generation_start_failed`.
--
-- Deliberately NOT a new `generations.status` value. status is read as set
-- membership in at least eight places outside the reaper, and dropping out of
-- `ACTIVE_START_STATUSES` in generation-start-idempotency.ts would stop a
-- same-key resubmit being deduped as a replay -- charging the user a second time
-- while the first task may still succeed. A nullable marker column adds the
-- information without changing the shape every other subsystem matches on.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS submission_unknown_at timestamptz;

COMMENT ON COLUMN public.generations.submission_unknown_at IS
  'Set when provider task creation timed out with an unknown outcome. The row stays pending and held; a callback rescues it, or the stalled-generation reaper refunds it after its window. Retained after settlement as the evidence that a refund was an ambiguous one.';

-- Small and partial: the only readers are the reaper (logging) and ops
-- reconciliation, both of which want the marked rows, never the unmarked ones.
CREATE INDEX IF NOT EXISTS generations_submission_unknown_idx
  ON public.generations (submission_unknown_at)
  WHERE submission_unknown_at IS NOT NULL;


-- Stamp the marker, but only while the row is still genuinely held.
--
-- The callback can beat this write: task creation times out at 30s, and Kie may
-- have accepted the task and called back before the catch block runs. Refusing
-- in that case keeps the marker meaning exactly one thing -- "this submission
-- was never confirmed" -- and hands back a status the caller can log instead of
-- silently annotating a generation that is already running.
CREATE OR REPLACE FUNCTION public.mark_generation_submission_unknown(
  p_generation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
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
    RETURN jsonb_build_object(
      'status', 'provider_task_attached',
      'generation_id', v_generation.id,
      'prediction_id', v_generation.prediction_id
    );
  END IF;

  IF v_generation.status NOT IN ('pending', 'waiting')
     OR coalesce(v_generation.refunded, false) THEN
    RETURN jsonb_build_object(
      'status', 'already_settled',
      'generation_id', v_generation.id,
      'generation_status', v_generation.status,
      'refunded', coalesce(v_generation.refunded, false)
    );
  END IF;

  IF v_generation.submission_unknown_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_marked',
      'generation_id', v_generation.id,
      'submission_unknown_at', v_generation.submission_unknown_at
    );
  END IF;

  UPDATE public.generations
  SET submission_unknown_at = timezone('utc'::text, now())
  WHERE id = v_generation.id;

  RETURN jsonb_build_object('status', 'held', 'generation_id', v_generation.id);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_generation_submission_unknown(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_generation_submission_unknown(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.mark_generation_submission_unknown(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_generation_submission_unknown(uuid) TO service_role;


-- Ops reconciliation ledger for the residual race the grace window cannot close.
--
-- A callback can always arrive after the window expired and the reaper refunded.
-- The provider did the work and will bill for it, so the discrepancy has to
-- outlive the request: a log line is not queryable against money, and log
-- retention is finite (F15b's log drain is still open). One row per generation --
-- providers retry callbacks, and a retry is not a second discrepancy.
CREATE TABLE IF NOT EXISTS public.provider_submission_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL UNIQUE REFERENCES public.generations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  prediction_id text NOT NULL,
  refunded_credits integer NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_note text,
  CONSTRAINT provider_submission_reconciliations_prediction_id_not_blank
    CHECK (btrim(prediction_id) <> ''),
  CONSTRAINT provider_submission_reconciliations_refunded_credits_check
    CHECK (refunded_credits >= 0),
  CONSTRAINT provider_submission_reconciliations_resolution_pair_check CHECK (
    (resolved_at IS NULL AND resolution_note IS NULL)
    OR (resolved_at IS NOT NULL AND resolution_note IS NOT NULL AND btrim(resolution_note) <> '')
  )
);

CREATE INDEX IF NOT EXISTS provider_submission_reconciliations_open_idx
  ON public.provider_submission_reconciliations (detected_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.provider_submission_reconciliations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.provider_submission_reconciliations FROM PUBLIC;
REVOKE ALL ON public.provider_submission_reconciliations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_submission_reconciliations TO service_role;


-- Record a late callback only for the shape that actually loses money.
--
-- The webhook reaches this path via `already_settled`, which also fires for
-- ordinary duplicate callbacks on generations that succeeded normally. The shape
-- test lives here rather than in the caller so the invariant is enforced once,
-- at the write: refunded, and marked as an ambiguous submission. Without both,
-- the table fills with benign duplicates and ops stops reading it.
CREATE OR REPLACE FUNCTION public.record_provider_submission_reconciliation(
  p_generation_id uuid,
  p_prediction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_prediction_id text := btrim(coalesce(p_prediction_id, ''));
  v_id uuid;
BEGIN
  IF p_generation_id IS NULL OR v_prediction_id = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_generation.submission_unknown_at IS NULL
     OR NOT coalesce(v_generation.refunded, false) THEN
    RETURN jsonb_build_object('status', 'not_applicable', 'generation_id', v_generation.id);
  END IF;

  INSERT INTO public.provider_submission_reconciliations (
    generation_id,
    user_id,
    prediction_id,
    refunded_credits
  )
  VALUES (
    v_generation.id,
    v_generation.user_id,
    v_prediction_id,
    greatest(0, coalesce(v_generation.cost, 0))
  )
  ON CONFLICT (generation_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'generation_id', v_generation.id);
  END IF;

  RETURN jsonb_build_object(
    'status', 'recorded',
    'generation_id', v_generation.id,
    'reconciliation_id', v_id,
    'refunded_credits', greatest(0, coalesce(v_generation.cost, 0))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_provider_submission_reconciliation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_provider_submission_reconciliation(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_provider_submission_reconciliation(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_submission_reconciliation(uuid, text) TO service_role;


-- Surface the marker in the settlement result so the reaper can tell a held
-- ambiguous submission from a genuine start failure. Body is otherwise
-- unchanged from 20260712123000; the marker is deliberately NOT cleared, since
-- it is what `record_provider_submission_reconciliation` keys on afterwards.
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

  SELECT credits INTO v_remaining_credits
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

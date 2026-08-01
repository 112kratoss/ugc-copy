-- Creator payouts.
--
-- creator_resource_wallets has been accruing an exact 85% share since the sale
-- economics migration, with no way for the money to leave. This adds the
-- withdrawal side: a creator requests a payout, the balance moves into a hold
-- so it cannot be requested twice, and an operator marks it paid or rejects it
-- (which releases the hold).
--
-- The rail is deliberately manual for v1: /admin is a single master operator,
-- and wiring an automated payout provider before there is payout volume adds a
-- compliance surface with nothing behind it. The state machine here does not
-- change when that rail arrives -- only who calls `mark_paid`.

-- 10,000 token subunits = 100 tokens = $1. The $100 minimum is therefore
-- 1,000,000 subunits.
CREATE TABLE IF NOT EXISTS public.creator_payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_token_subunits bigint NOT NULL CHECK (amount_token_subunits > 0),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'paid', 'rejected')),
  payout_method text NOT NULL CHECK (char_length(btrim(payout_method)) BETWEEN 2 AND 40),
  -- Free-form because the rails differ by country; the operator reads it, no
  -- code parses it. Never contains a full account number by policy: creators
  -- are asked for a UPI id or the last four digits plus a contact.
  payout_details text NOT NULL CHECK (char_length(btrim(payout_details)) BETWEEN 3 AND 500),
  requested_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Bank reference / UTR for a paid request, or the reason for a rejection.
  resolution_note text,
  external_reference text,
  CONSTRAINT creator_payout_requests_resolution_shape CHECK (
    (status = 'requested' AND resolved_at IS NULL)
    OR (status <> 'requested' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS creator_payout_requests_user_requested_idx
  ON public.creator_payout_requests (user_id, requested_at DESC);

-- The operator queue reads this constantly; open requests are the hot set.
CREATE INDEX IF NOT EXISTS creator_payout_requests_open_idx
  ON public.creator_payout_requests (requested_at)
  WHERE status = 'requested';

CREATE INDEX IF NOT EXISTS creator_payout_requests_resolved_by_idx
  ON public.creator_payout_requests (resolved_by)
  WHERE resolved_by IS NOT NULL;

-- A creator can have at most one request in flight. Without this, two rapid
-- submissions each pass the balance check before either debits the wallet.
CREATE UNIQUE INDEX IF NOT EXISTS creator_payout_requests_one_open_per_user_idx
  ON public.creator_payout_requests (user_id)
  WHERE status = 'requested';

ALTER TABLE public.creator_payout_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Creators can view their own payout requests"
  ON public.creator_payout_requests;
CREATE POLICY "Creators can view their own payout requests"
  ON public.creator_payout_requests FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL PRIVILEGES ON TABLE public.creator_payout_requests
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.creator_payout_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.creator_payout_requests TO service_role;

-- Held balance is money promised to an open request. Keeping it on the wallet
-- rather than deriving it from open requests means the balance check and the
-- debit happen under one row lock.
ALTER TABLE public.creator_resource_wallets
  ADD COLUMN IF NOT EXISTS held_token_subunits bigint NOT NULL DEFAULT 0
    CHECK (held_token_subunits >= 0),
  ADD COLUMN IF NOT EXISTS lifetime_paid_out_token_subunits bigint NOT NULL DEFAULT 0
    CHECK (lifetime_paid_out_token_subunits >= 0);

COMMENT ON COLUMN public.creator_resource_wallets.held_token_subunits IS
  'Balance committed to an open payout request. Already deducted from available_token_subunits; released back on rejection.';

CREATE OR REPLACE FUNCTION public.request_creator_payout(
  p_user_id uuid,
  p_payout_method text,
  p_payout_details text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_minimum_subunits constant bigint := 1000000; -- $100
  v_wallet public.creator_resource_wallets%ROWTYPE;
  v_method text := nullif(btrim(coalesce(p_payout_method, '')), '');
  v_details text := nullif(btrim(coalesce(p_payout_details, '')), '');
  v_request_id uuid;
  v_amount bigint;
BEGIN
  IF v_method IS NULL OR char_length(v_method) < 2 OR char_length(v_method) > 40 THEN
    RETURN jsonb_build_object('status', 'invalid_method');
  END IF;

  IF v_details IS NULL OR char_length(v_details) < 3 OR char_length(v_details) > 500 THEN
    RETURN jsonb_build_object('status', 'invalid_details');
  END IF;

  SELECT *
  INTO v_wallet
  FROM public.creator_resource_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'below_minimum', 'available_token_subunits', 0);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.creator_payout_requests
    WHERE user_id = p_user_id AND status = 'requested'
  ) THEN
    RETURN jsonb_build_object('status', 'already_pending');
  END IF;

  v_amount := v_wallet.available_token_subunits;

  IF v_amount < v_minimum_subunits THEN
    RETURN jsonb_build_object(
      'status', 'below_minimum',
      'available_token_subunits', v_amount,
      'minimum_token_subunits', v_minimum_subunits
    );
  END IF;

  -- Whole balance, moved to hold under the same lock that read it.
  UPDATE public.creator_resource_wallets
  SET available_token_subunits = 0,
      held_token_subunits = held_token_subunits + v_amount,
      updated_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id;

  INSERT INTO public.creator_payout_requests (
    user_id, amount_token_subunits, payout_method, payout_details
  )
  VALUES (p_user_id, v_amount, v_method, v_details)
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object(
    'status', 'requested',
    'request_id', v_request_id,
    'amount_token_subunits', v_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_creator_payout_request(
  p_request_id uuid,
  p_reviewer_id uuid,
  p_action text,
  p_resolution_note text DEFAULT NULL,
  p_external_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.creator_payout_requests%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_resolution_note, '')), '');
  v_now timestamptz := timezone('utc'::text, now());
BEGIN
  IF p_action NOT IN ('mark_paid', 'reject') THEN
    RETURN jsonb_build_object('status', 'invalid_action');
  END IF;

  SELECT *
  INTO v_request
  FROM public.creator_payout_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_request.status <> 'requested' THEN
    RETURN jsonb_build_object('status', 'already_resolved', 'current_status', v_request.status);
  END IF;

  -- A rejection must say why: the creator sees this text.
  IF p_action = 'reject' AND v_note IS NULL THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

  PERFORM 1
  FROM public.creator_resource_wallets
  WHERE user_id = v_request.user_id
  FOR UPDATE;

  IF p_action = 'mark_paid' THEN
    -- The hold is consumed: money left the platform.
    UPDATE public.creator_resource_wallets
    SET held_token_subunits = greatest(0, held_token_subunits - v_request.amount_token_subunits),
        lifetime_paid_out_token_subunits =
          lifetime_paid_out_token_subunits + v_request.amount_token_subunits,
        updated_at = v_now
    WHERE user_id = v_request.user_id;
  ELSE
    -- The hold is released: the creator can request again.
    UPDATE public.creator_resource_wallets
    SET held_token_subunits = greatest(0, held_token_subunits - v_request.amount_token_subunits),
        available_token_subunits = available_token_subunits + v_request.amount_token_subunits,
        updated_at = v_now
    WHERE user_id = v_request.user_id;
  END IF;

  UPDATE public.creator_payout_requests
  SET status = CASE WHEN p_action = 'mark_paid' THEN 'paid' ELSE 'rejected' END,
      resolved_at = v_now,
      resolved_by = p_reviewer_id,
      resolution_note = v_note,
      external_reference = nullif(btrim(coalesce(p_external_reference, '')), '')
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN p_action = 'mark_paid' THEN 'paid' ELSE 'rejected' END,
    'request_id', p_request_id,
    'amount_token_subunits', v_request.amount_token_subunits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_creator_payout(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_creator_payout(uuid, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.resolve_creator_payout_request(uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_creator_payout_request(uuid, uuid, text, text, text)
  TO service_role;

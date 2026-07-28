-- Admin credit adjustments.
--
-- Support work needs to move a user's balance by an ad-hoc amount: goodwill
-- after a failed generation, a manual refund, or clawing back an abusive grant.
-- `credit_grants` cannot express this — it is UNIQUE (user_id, program_key), so
-- it models "this user claimed program X once" and a second support grant to
-- the same user would conflict.
--
-- This table is therefore the audit log for operator-initiated balance changes,
-- and `apply_admin_credit_adjustment` is the only supported way to write one.
-- Direct UPDATEs on profiles.credits from the console are deliberately not
-- possible: the balance change and its justification must land in one
-- transaction or neither.
--
-- No `credits >= 0` clamp is applied, matching the DECISION recorded in
-- 20260725231000_credit_integrity_constraints.sql: refund clawbacks are allowed
-- to drive a balance negative rather than silently forgive spend.

CREATE TABLE public.admin_credit_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The operator who authorised the change. A real auth user, never a synthetic
  -- id, so the audit trail survives a move to per-person admin accounts.
  reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  credits_delta integer NOT NULL DEFAULT 0,
  promotional_credits_delta integer NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  credits_balance_after integer NOT NULL,
  promotional_credits_balance_after integer NOT NULL,
  -- Supplied by the caller so a double-submitted form cannot double-credit.
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT admin_credit_adjustments_nonzero CHECK (
    credits_delta <> 0 OR promotional_credits_delta <> 0
  )
);

CREATE UNIQUE INDEX admin_credit_adjustments_idempotency_key_idx
  ON public.admin_credit_adjustments (idempotency_key);

CREATE INDEX admin_credit_adjustments_user_created_idx
  ON public.admin_credit_adjustments (user_id, created_at DESC);

CREATE INDEX admin_credit_adjustments_reviewer_created_idx
  ON public.admin_credit_adjustments (reviewer_id, created_at DESC);

ALTER TABLE public.admin_credit_adjustments ENABLE ROW LEVEL SECURITY;

-- Operator-only data: it names the reviewer and describes internal support
-- decisions, so it never belongs on the public Data API.
REVOKE ALL ON TABLE public.admin_credit_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_credit_adjustments TO service_role;

COMMENT ON TABLE public.admin_credit_adjustments IS
  'Audit log of operator-initiated credit balance changes made from the /admin console.';

CREATE OR REPLACE FUNCTION public.apply_admin_credit_adjustment(
  p_user_id uuid,
  p_reviewer_id uuid,
  p_credits_delta integer,
  p_promotional_credits_delta integer,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.admin_credit_adjustments%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_credits_after integer;
  v_promotional_after integer;
  v_adjustment_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_reviewer_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'user and reviewer are required');
  END IF;

  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'reason is required');
  END IF;

  IF nullif(btrim(coalesce(p_idempotency_key, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'idempotency key is required');
  END IF;

  IF coalesce(p_credits_delta, 0) = 0 AND coalesce(p_promotional_credits_delta, 0) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid', 'error', 'adjustment must change a balance');
  END IF;

  -- Replaying the same key returns the original outcome instead of applying a
  -- second delta, so a retried request is safe.
  SELECT * INTO v_existing
  FROM public.admin_credit_adjustments
  WHERE idempotency_key = btrim(p_idempotency_key);

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'adjustment_id', v_existing.id,
      'credits', v_existing.credits_balance_after,
      'promotional_credits', v_existing.promotional_credits_balance_after
    );
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_credits_after := coalesce(v_profile.credits, 0) + coalesce(p_credits_delta, 0);
  v_promotional_after := coalesce(v_profile.promotional_credits, 0)
    + coalesce(p_promotional_credits_delta, 0);

  UPDATE public.profiles
  SET credits = v_credits_after,
      promotional_credits = v_promotional_after
  WHERE id = p_user_id;

  INSERT INTO public.admin_credit_adjustments (
    user_id,
    reviewer_id,
    credits_delta,
    promotional_credits_delta,
    reason,
    credits_balance_after,
    promotional_credits_balance_after,
    idempotency_key
  ) VALUES (
    p_user_id,
    p_reviewer_id,
    coalesce(p_credits_delta, 0),
    coalesce(p_promotional_credits_delta, 0),
    btrim(p_reason),
    v_credits_after,
    v_promotional_after,
    btrim(p_idempotency_key)
  )
  RETURNING id INTO v_adjustment_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'adjustment_id', v_adjustment_id,
    'credits', v_credits_after,
    'promotional_credits', v_promotional_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_admin_credit_adjustment(uuid, uuid, integer, integer, text, text) TO service_role;

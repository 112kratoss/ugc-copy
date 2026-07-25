-- Guard refund-before-capture reconciliation.
--
-- `reconcile_credit_purchase_adjustment` previously debited the purchaser's
-- base credits for every reversal snapshot without checking whether the
-- purchase grant had ever been applied. A refund or dispute processed while
-- the transaction was still 'created' (capture webhook lost, delayed, or the
-- dispute raced the grant) therefore:
--   1. debited credits that were never granted (balance theft), and
--   2. flipped a partially-reversed 'created' transaction to
--      'success'/credit_effect_applied = true without any grant, wedging it so
--      `add_credits` refused it and the user never received the credits.
--
-- This rewrite mirrors the guarded pattern already used by
-- `reconcile_mobile_credit_refund`
-- (20260620035057_prepare_mobile_credit_refund_reconciliation.sql): when the
-- grant never applied, record the reversal in the adjustment ledger with a
-- zero balance delta, mark the transaction refunded so `add_credits` can no
-- longer grant it (it only grants 'created' rows), and leave
-- `profiles.credits` untouched.
--
-- "Grant applied" is derived from durable state, not the mutable
-- `credit_effect_applied` flag alone, because a granted-then-fully-reversed
-- transaction also carries status = 'refunded' / credit_effect_applied = false
-- and its restore path must keep crediting:
--   * status = 'success' AND credit_effect_applied      -> granted, active
--   * any prior adjustment row with base_credit_delta<>0 -> granted, reversed
--   * neither                                            -> never granted
--
-- Never-granted transactions never move the balance in either direction:
-- reversals are recorded and void the transaction, and a later provider
-- restore is bookkeeping-only (the adjustment ledger keeps the trail for
-- manual reconciliation if the payment ultimately stands).

CREATE OR REPLACE FUNCTION public.reconcile_credit_purchase_adjustment(
  p_transaction_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_cumulative_reversed_subunits bigint,
  p_action text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transaction public.transactions%ROWTYPE;
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_grant_applied boolean := false;
  v_previous_reversed_credits integer;
  v_target_reversed_credits integer;
  v_credit_delta integer;
  v_applied_credit_delta integer := 0;
  v_balance integer;
  v_settlement jsonb;
  v_referral_adjustment jsonb := jsonb_build_object('status', 'not_settled', 'rewards', '[]'::jsonb);
  v_status text;
BEGIN
  IF p_transaction_id IS NULL
     OR v_provider NOT IN ('razorpay', 'revenuecat')
     OR nullif(btrim(coalesce(p_provider_event_id, '')), '') IS NULL
     OR p_cumulative_reversed_subunits IS NULL
     OR p_cumulative_reversed_subunits < 0
     OR v_action NOT IN ('reverse', 'restore')
     OR nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND OR v_transaction.amount <= 0 OR v_transaction.credits <= 0 THEN
    RETURN jsonb_build_object('status', 'transaction_not_found', 'rewards', '[]'::jsonb);
  END IF;

  IF p_cumulative_reversed_subunits > v_transaction.amount THEN
    RETURN jsonb_build_object('status', 'invalid_amount', 'rewards', '[]'::jsonb);
  END IF;

  -- Refund/dispute snapshots are monotonic. A delayed smaller snapshot cannot
  -- restore value; only an explicit provider-verified restore/won event may do
  -- that. Conversely a restore event may not increase the reversed target.
  IF (v_action = 'reverse'
      AND p_cumulative_reversed_subunits < v_transaction.credit_reversed_amount_subunits)
     OR (v_action = 'restore'
      AND p_cumulative_reversed_subunits > v_transaction.credit_reversed_amount_subunits) THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
  END IF;

  IF (v_provider = 'razorpay' AND v_transaction.mobile_product_id IS NOT NULL)
     OR (v_provider = 'revenuecat' AND v_transaction.mobile_product_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'provider_mismatch', 'rewards', '[]'::jsonb);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.credit_purchase_adjustments
    WHERE provider = v_provider
      AND provider_event_id = btrim(p_provider_event_id)
  ) THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  -- Was the purchase grant ever applied to the balance? Active grants carry
  -- status 'success' with the effect flag set; grants that were later reversed
  -- have left non-zero balance deltas in the adjustment ledger. A transaction
  -- with neither never moved the balance, so no reversal may debit it.
  v_grant_applied := (
    v_transaction.status = 'success'
    AND coalesce(v_transaction.credit_effect_applied, false)
  ) OR EXISTS (
    SELECT 1 FROM public.credit_purchase_adjustments
    WHERE transaction_id = p_transaction_id
      AND base_credit_delta <> 0
  );

  -- Record/grant the verified purchase before changing its active state. This
  -- ensures an immediate refund still permanently consumes the invitee's one
  -- first-purchase bonus slot, then reverses that bonus in the same transaction.
  IF v_transaction.status = 'success'
     AND coalesce(v_transaction.credit_effect_applied, false) THEN
    v_settlement := public.settle_referral_purchase_rewards(p_transaction_id);
  END IF;

  v_previous_reversed_credits := v_transaction.credit_reversed_credits;
  v_target_reversed_credits := CASE
    WHEN p_cumulative_reversed_subunits = v_transaction.amount THEN v_transaction.credits
    ELSE floor(
      v_transaction.credits::numeric
      * p_cumulative_reversed_subunits::numeric
      / v_transaction.amount::numeric
    )::integer
  END;
  v_credit_delta := v_target_reversed_credits - v_previous_reversed_credits;

  -- Only grants that actually reached the balance may be debited (or, on a
  -- provider restore, re-credited). Never-granted transactions keep their
  -- reversal bookkeeping but a zero balance delta.
  v_applied_credit_delta := CASE WHEN v_grant_applied THEN v_credit_delta ELSE 0 END;

  IF v_applied_credit_delta <> 0 THEN
    UPDATE public.profiles
    SET credits = credits - v_applied_credit_delta
    WHERE id = v_transaction.user_id
    RETURNING credits INTO v_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'profile not found for purchase adjustment';
    END IF;

    v_referral_adjustment := public.reconcile_referral_purchase_reward_adjustment(
      p_transaction_id,
      CASE WHEN v_applied_credit_delta > 0 THEN 'reverse' ELSE 'restore' END,
      abs(v_applied_credit_delta),
      v_provider || ':' || btrim(p_provider_event_id),
      p_reason
    );
    SELECT credits INTO v_balance
    FROM public.profiles
    WHERE id = v_transaction.user_id;
  ELSE
    SELECT credits INTO v_balance
    FROM public.profiles
    WHERE id = v_transaction.user_id;
  END IF;

  INSERT INTO public.credit_purchase_adjustments (
    transaction_id,
    provider,
    provider_event_id,
    reason,
    previous_reversed_amount_subunits,
    target_reversed_amount_subunits,
    previous_reversed_credits,
    target_reversed_credits,
    base_credit_delta
  ) VALUES (
    p_transaction_id,
    v_provider,
    btrim(p_provider_event_id),
    left(btrim(p_reason), 200),
    v_transaction.credit_reversed_amount_subunits,
    p_cumulative_reversed_subunits,
    v_previous_reversed_credits,
    v_target_reversed_credits,
    -v_applied_credit_delta
  );

  v_status := CASE
    WHEN v_credit_delta = 0 THEN 'no_change'
    WHEN v_target_reversed_credits = 0 THEN 'restored'
    WHEN v_target_reversed_credits = v_transaction.credits THEN 'reversed'
    WHEN v_credit_delta > 0 THEN 'partially_reversed'
    ELSE 'partially_restored'
  END;

  IF v_grant_applied THEN
    UPDATE public.transactions
    SET credit_reversed_amount_subunits = p_cumulative_reversed_subunits,
        credit_reversed_credits = v_target_reversed_credits,
        status = CASE
          WHEN v_target_reversed_credits = credits THEN 'refunded'
          ELSE 'success'
        END,
        credit_effect_applied = v_target_reversed_credits < credits,
        refunded_at = CASE
          WHEN v_target_reversed_credits = credits THEN timezone('utc'::text, now())
          ELSE NULL
        END,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_transaction_id;
  ELSIF p_cumulative_reversed_subunits > 0 THEN
    -- Refund/dispute before the grant ever applied: void the purchase. The
    -- 'refunded' status keeps `add_credits` from granting it later (it only
    -- grants 'created' rows), and the effect flag stays false because no
    -- credits ever reached the balance.
    UPDATE public.transactions
    SET credit_reversed_amount_subunits = p_cumulative_reversed_subunits,
        credit_reversed_credits = v_target_reversed_credits,
        status = 'refunded',
        credit_effect_applied = false,
        refunded_at = coalesce(refunded_at, timezone('utc'::text, now())),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_transaction_id;
  ELSE
    -- Bookkeeping-only snapshot (a restore to zero, or a zero-value event) on
    -- a never-granted transaction: track the provider's cumulative state but
    -- do not manufacture a grant. A still-'created' transaction stays eligible
    -- for its real grant; an already-voided one stays void.
    UPDATE public.transactions
    SET credit_reversed_amount_subunits = p_cumulative_reversed_subunits,
        credit_reversed_credits = v_target_reversed_credits,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_transaction_id;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'transaction_id', p_transaction_id,
    'base_credit_delta', -v_applied_credit_delta,
    'active_base_credits', v_transaction.credits - v_target_reversed_credits,
    'remaining_credits', v_balance,
    'rewards', coalesce(v_referral_adjustment -> 'rewards', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid, text, text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid, text, text, bigint, text, text) TO service_role;

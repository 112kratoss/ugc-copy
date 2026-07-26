-- Bind Razorpay payment evidence while reconciling credit adjustments.
--
-- Refund/dispute events can arrive before a capture event. The guarded
-- reconciliation correctly voids an ungranted transaction without changing
-- its balance, but the legacy Razorpay wrapper did not persist the payment ID.
-- That left a terminal row without provider audit linkage and made a later
-- payment-only event impossible to resolve. This wrapper keeps payment binding,
-- uniqueness enforcement, and the ledger adjustment in one transaction.

CREATE OR REPLACE FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(
  p_transaction_id uuid,
  p_provider_event_id text,
  p_payment_id text,
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
  v_result jsonb;
  v_status text;
  v_payment_id text := btrim(coalesce(p_payment_id, ''));
  v_duplicate_matches_transaction boolean := false;
BEGIN
  IF p_transaction_id IS NULL OR v_payment_id = '' THEN
    RETURN jsonb_build_object('status', 'invalid_request', 'rewards', '[]'::jsonb);
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'transaction_not_found', 'rewards', '[]'::jsonb);
  END IF;

  IF v_transaction.mobile_product_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'provider_mismatch', 'rewards', '[]'::jsonb);
  END IF;

  IF v_transaction.razorpay_payment_id IS NOT NULL
     AND v_transaction.razorpay_payment_id <> v_payment_id THEN
    RETURN jsonb_build_object('status', 'payment_conflict', 'rewards', '[]'::jsonb);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.transactions
    WHERE razorpay_payment_id = v_payment_id
      AND id <> p_transaction_id
  ) THEN
    RETURN jsonb_build_object('status', 'payment_conflict', 'rewards', '[]'::jsonb);
  END IF;

  v_result := public.reconcile_credit_purchase_adjustment(
    p_transaction_id,
    'razorpay',
    p_provider_event_id,
    p_cumulative_reversed_subunits,
    p_action,
    p_reason
  );
  v_status := v_result ->> 'status';

  IF v_status IN (
    'invalid_request',
    'transaction_not_found',
    'provider_mismatch',
    'invalid_amount'
  ) THEN
    RETURN v_result;
  END IF;

  IF v_status = 'duplicate_event' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.credit_purchase_adjustments
      WHERE transaction_id = p_transaction_id
        AND provider = 'razorpay'
        AND provider_event_id = btrim(p_provider_event_id)
    ) INTO v_duplicate_matches_transaction;

    IF NOT v_duplicate_matches_transaction THEN
      RETURN jsonb_build_object('status', 'event_conflict', 'rewards', '[]'::jsonb);
    END IF;
  END IF;

  UPDATE public.transactions
  SET razorpay_payment_id = v_payment_id,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_transaction_id
    AND (
      razorpay_payment_id IS NULL
      OR razorpay_payment_id = v_payment_id
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment binding changed concurrently';
  END IF;

  RETURN v_result || jsonb_build_object('payment_id_bound', true);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'payment_conflict', 'rewards', '[]'::jsonb);
END;
$$;

DROP FUNCTION IF EXISTS public.reconcile_razorpay_credit_purchase_adjustment(
  uuid,
  text,
  bigint,
  text,
  text
);

REVOKE ALL ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(
  uuid,
  text,
  text,
  bigint,
  text,
  text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(
  uuid,
  text,
  text,
  bigint,
  text,
  text
) TO service_role;

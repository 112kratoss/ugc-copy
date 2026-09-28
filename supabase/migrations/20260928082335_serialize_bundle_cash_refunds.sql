-- Match the existing bundle -> order lock discipline before entitlement and wallet changes.
CREATE OR REPLACE FUNCTION public.reconcile_post_resource_cash_adjustment(
  p_provider_event_id text,
  p_payment_id text,
  p_action text,
  p_reason text DEFAULT NULL,
  p_provider_order_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_id text := btrim(coalesce(p_provider_event_id, ''));
  v_payment_id text := btrim(coalesce(p_payment_id, ''));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_provider_order_id text :=
    nullif(btrim(coalesce(p_provider_order_id, '')), '');
  v_existing public.cash_purchase_adjustments%ROWTYPE;
  v_order public.post_resource_bundle_orders%ROWTYPE;
  v_purchase public.post_resource_bundle_purchases%ROWTYPE;
BEGIN
  IF length(v_event_id) NOT BETWEEN 1 AND 255
    OR length(v_payment_id) NOT BETWEEN 1 AND 255
    OR (
      v_provider_order_id IS NOT NULL
      AND length(v_provider_order_id) NOT BETWEEN 1 AND 255
    )
    OR v_action NOT IN ('refund', 'dispute', 'restore') THEN
    RAISE EXCEPTION 'Invalid post-resource cash adjustment'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cash-event:' || v_event_id, 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('post-resource-payment:' || v_payment_id, 0)
  );

  SELECT *
  INTO v_existing
  FROM public.cash_purchase_adjustments
  WHERE provider_event_id = v_event_id
     OR (
       purchase_kind = 'post_resource'
       AND provider_payment_id = v_payment_id
       AND action = v_action
     )
  ORDER BY (provider_event_id = v_event_id) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.outcome = 'manual_review' THEN 'manual_review'
        ELSE 'already_adjusted'
      END,
      'adjustment_id', v_existing.id,
      'action', v_existing.action
    );
  END IF;

  SELECT *
  INTO v_order
  FROM public.post_resource_bundle_orders
  WHERE razorpay_payment_id = v_payment_id
     OR (
       v_provider_order_id IS NOT NULL
       AND razorpay_order_id = v_provider_order_id
     )
  ORDER BY (razorpay_payment_id = v_payment_id) DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Capture, quote recording and bundle deletion all lock bundle before order.
  -- Reversing that order can deadlock a refund against another checkout for
  -- this buyer when entitlement deletion blocks its unique purchase insert.
  PERFORM 1 FROM public.post_resource_bundles
  WHERE id = v_order.bundle_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- State can change while waiting for the bundle; never act on the old read.
  SELECT * INTO v_order
  FROM public.post_resource_bundle_orders AS orders
  WHERE orders.id = v_order.id
    AND orders.bundle_id = v_order.bundle_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_provider_order_id IS NOT NULL
    AND v_order.razorpay_order_id IS DISTINCT FROM v_provider_order_id THEN
    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  IF v_order.razorpay_payment_id IS NOT NULL
    AND v_order.razorpay_payment_id IS DISTINCT FROM v_payment_id THEN
    RETURN jsonb_build_object('status', 'payment_conflict');
  END IF;

  IF v_action = 'restore' THEN
    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      post_resource_order_id,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'post_resource',
      v_action,
      'manual_review',
      v_order.id,
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'manual_review',
      'adjustment_id', v_existing.id,
      'action', v_action
    );
  END IF;

  IF v_order.status = 'created' THEN
    UPDATE public.post_resource_bundle_orders
    SET status = 'failed',
        razorpay_payment_id = v_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'created';

    INSERT INTO public.cash_purchase_adjustments (
      provider_event_id,
      provider_payment_id,
      purchase_kind,
      action,
      outcome,
      post_resource_order_id,
      entitlement_snapshot,
      reason
    ) VALUES (
      v_event_id,
      v_payment_id,
      'post_resource',
      v_action,
      'adjusted',
      v_order.id,
      jsonb_build_object(
        'prior_status', 'created',
        'entitlement_granted', false,
        'provider_order_id', v_order.razorpay_order_id
      ),
      v_reason
    )
    RETURNING * INTO v_existing;

    RETURN jsonb_build_object(
      'status', 'adjusted',
      'adjustment_id', v_existing.id,
      'action', v_action,
      'order_id', v_order.id,
      'capture_blocked', true
    );
  END IF;

  IF v_order.status <> 'paid' THEN
    RETURN jsonb_build_object('status', 'not_paid');
  END IF;

  SELECT *
  INTO v_purchase
  FROM public.post_resource_bundle_purchases
  WHERE order_id = v_order.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'entitlement_missing');
  END IF;

  -- The paid -> failed transition occurs after entitlement deletion so
  -- reverse_post_resource_wallet_on_refund can reverse the exact sale ledger.
  DELETE FROM public.post_resource_bundle_purchases
  WHERE id = v_purchase.id;

  UPDATE public.post_resource_bundle_orders
  SET status = 'failed',
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id;

  UPDATE public.post_resource_bundles
  SET sales_count = greatest(0, sales_count - 1),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.bundle_id;

  INSERT INTO public.cash_purchase_adjustments (
    provider_event_id,
    provider_payment_id,
    purchase_kind,
    action,
    outcome,
    post_resource_order_id,
    entitlement_snapshot,
    reason
  ) VALUES (
    v_event_id,
    v_payment_id,
    'post_resource',
    v_action,
    'adjusted',
    v_order.id,
    to_jsonb(v_purchase),
    v_reason
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'status', 'adjusted',
    'adjustment_id', v_existing.id,
    'action', v_action,
    'order_id', v_order.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_post_resource_cash_adjustment(text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_post_resource_cash_adjustment(text, text, text, text, text)
  TO service_role;

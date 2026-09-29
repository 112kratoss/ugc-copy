-- Bind an immutable credit event to its transaction and reversal target.
-- RevenueCat wrappers propagate unresolved/duplicate outcomes without consuming
-- an event or changing receipt status. Existing financial and locking logic stays intact.
DO $migration$
DECLARE
  definition text;
  old_block text;
  new_block text;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$  -- Refund/dispute snapshots are monotonic. A delayed smaller snapshot cannot
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
  END IF;$old$;
  new_block := $new$  IF (v_provider = 'razorpay' AND v_transaction.mobile_product_id IS NOT NULL)
     OR (v_provider = 'revenuecat' AND v_transaction.mobile_product_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'provider_mismatch', 'rewards', '[]'::jsonb);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.credit_purchase_adjustments
    WHERE provider = v_provider
      AND provider_event_id = btrim(p_provider_event_id)
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.credit_purchase_adjustments
      WHERE provider = v_provider
        AND provider_event_id = btrim(p_provider_event_id)
        AND (transaction_id <> p_transaction_id
          OR target_reversed_amount_subunits <> p_cumulative_reversed_subunits)
    ) THEN
      RETURN jsonb_build_object('status', 'event_conflict', 'rewards', '[]'::jsonb);
    END IF;
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  -- Refund/dispute snapshots are monotonic. A delayed smaller snapshot cannot
  -- restore value; only an explicit provider-verified restore/won event may do
  -- that. Conversely a restore event may not increase the reversed target.
  IF (v_action = 'reverse'
      AND p_cumulative_reversed_subunits < v_transaction.credit_reversed_amount_subunits)
     OR (v_action = 'restore'
      AND p_cumulative_reversed_subunits > v_transaction.credit_reversed_amount_subunits) THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
  END IF;$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_transaction.revenuecat_event_id = p_event_id THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;$old$;
  new_block := $new$  -- The immutable credit event validates both transaction and financial target.$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_adjustment ->> 'status' IN ('invalid_request', 'transaction_not_found', 'provider_mismatch', 'invalid_amount') THEN$old$;
  new_block := $new$  IF coalesce(v_adjustment ->> 'status', '') NOT IN (
    'no_change', 'reversed', 'partially_reversed', 'restored', 'partially_restored'
  ) THEN$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_ledger.provider_event_id = p_event_id THEN$old$;
  new_block := $new$  IF v_ledger.entitlement_type <> 'credits' AND v_ledger.provider_event_id = p_event_id THEN$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$    IF v_credit_adjustment ->> 'status' IN (
      'not_found',
      'identity_mismatch',
      'stale_event',
      'duplicate_event',
      'invalid_request',
      'transaction_not_found',
      'provider_mismatch',
      'invalid_amount'
    ) THEN$old$;
  new_block := $new$    IF coalesce(v_credit_adjustment ->> 'status', '') NOT IN (
      'refunded', 'already_refunded', 'restored', 'already_active'
    ) THEN$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);

  SELECT pg_get_functiondef('public.reconcile_razorpay_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_status IN (
    'invalid_request',
    'transaction_not_found',
    'provider_mismatch',
    'invalid_amount'
  ) THEN$old$;
  new_block := $new$  IF coalesce(v_status, '') NOT IN (
    'no_change', 'reversed', 'partially_reversed', 'restored', 'partially_restored',
    'duplicate_event', 'stale_event'
  ) THEN$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one credit event identity block in reconcile_razorpay_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END;
$migration$;
REVOKE ALL ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(uuid,text,text,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_razorpay_credit_purchase_adjustment(uuid,text,text,bigint,text,text) TO service_role;

-- Retain consumed RevenueCat event identities across receipt state transitions.
CREATE TABLE public.mobile_purchase_adjustment_events (
  provider_event_id text PRIMARY KEY CHECK (provider_event_id = btrim(provider_event_id) AND provider_event_id <> ''),
  mobile_store_transaction_id uuid NOT NULL REFERENCES public.mobile_store_transactions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('refund', 'restore')),
  provider_event_timestamp_ms bigint NOT NULL CHECK (provider_event_timestamp_ms > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_purchase_adjustment_events_receipt_idx
  ON public.mobile_purchase_adjustment_events(mobile_store_transaction_id);
ALTER TABLE public.mobile_purchase_adjustment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_purchase_adjustment_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.mobile_purchase_adjustment_events TO service_role;
-- Latest receipt snapshots can be preserved exactly. A duplicate event across
-- receipts or incomplete timestamp aborts migration instead of guessing a winner.
-- Earlier noncredit events were overwritten and cannot be reconstructed.
INSERT INTO public.mobile_purchase_adjustment_events
  (provider_event_id, mobile_store_transaction_id, action, provider_event_timestamp_ms)
SELECT btrim(provider_event_id), id, CASE WHEN status='revoked' THEN 'refund' ELSE 'restore' END,
  provider_event_timestamp_ms
FROM public.mobile_store_transactions WHERE provider_event_id IS NOT NULL;

DO $migration$
DECLARE definition text; old_block text; new_block text;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  v_ledger public.mobile_store_transactions%ROWTYPE;$old$;
  new_block := $new$  v_ledger public.mobile_store_transactions%ROWTYPE;
  v_event public.mobile_purchase_adjustment_events%ROWTYPE;$new$;
  IF (length(definition)-length(replace(definition,old_block,'')))/length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile event history block 1';
  END IF;
  EXECUTE replace(definition,old_block,new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  SELECT * INTO v_ledger
  FROM public.mobile_store_transactions
  WHERE external_order_id = p_external_order_id
  FOR UPDATE;$old$;
  new_block := $new$  p_event_id := btrim(p_event_id);
  -- One global provider-event lock precedes receipt locks. Concurrent deliveries
  -- to different receipts must see the winner before touching entitlements.
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile_adjustment_event:' || p_event_id, 0));

  SELECT * INTO v_ledger
  FROM public.mobile_store_transactions
  WHERE external_order_id = p_external_order_id
  FOR UPDATE;$new$;
  IF (length(definition)-length(replace(definition,old_block,'')))/length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile event history block 2';
  END IF;
  EXECUTE replace(definition,old_block,new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_ledger.entitlement_type <> 'credits' AND v_ledger.provider_event_id = p_event_id THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;$old$;
  new_block := $new$  SELECT * INTO v_event FROM public.mobile_purchase_adjustment_events
  WHERE provider_event_id = p_event_id;
  IF FOUND AND (
    v_event.mobile_store_transaction_id <> v_ledger.id
    OR v_event.action <> p_action
    OR v_event.provider_event_timestamp_ms <> p_event_timestamp_ms
  ) THEN
    RETURN jsonb_build_object('status', 'event_conflict', 'rewards', '[]'::jsonb);
  END IF;
  -- Credit events predating this history table still reserve their identities
  -- through the immutable credit ledger, including across entitlement kinds.
  IF EXISTS (
    SELECT 1 FROM public.credit_purchase_adjustments a
    WHERE a.provider = 'revenuecat' AND a.provider_event_id = p_event_id
      AND (v_ledger.entitlement_type <> 'credits'
        OR a.transaction_id IS DISTINCT FROM v_ledger.source_record_id
        OR a.target_reversed_amount_subunits <> CASE WHEN p_action = 'refund' THEN v_ledger.amount_subunits ELSE 0 END)
  ) THEN
    RETURN jsonb_build_object('status', 'event_conflict', 'rewards', '[]'::jsonb);
  END IF;$new$;
  IF (length(definition)-length(replace(definition,old_block,'')))/length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile event history block 3';
  END IF;
  EXECUTE replace(definition,old_block,new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  IF v_ledger.entitlement_type = 'credits' THEN
    v_credit_adjustment := public.reconcile_mobile_credit_purchase_adjustment($old$;
  new_block := $new$  IF v_event.provider_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  IF v_ledger.entitlement_type = 'credits' THEN
    v_credit_adjustment := public.reconcile_mobile_credit_purchase_adjustment($new$;
  IF (length(definition)-length(replace(definition,old_block,'')))/length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile event history block 4';
  END IF;
  EXECUTE replace(definition,old_block,new_block);

  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)'::regprocedure) INTO definition;
  old_block := $old$  UPDATE public.mobile_store_transactions
  SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'active' END,$old$;
  new_block := $new$  -- Record only successfully resolved adjustments, atomically with their effects.
  -- Not-found, stale and failed restores do not reserve an event or block retry.
  INSERT INTO public.mobile_purchase_adjustment_events
    (provider_event_id, mobile_store_transaction_id, action, provider_event_timestamp_ms)
  VALUES (p_event_id, v_ledger.id, p_action, p_event_timestamp_ms);

  UPDATE public.mobile_store_transactions
  SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'active' END,$new$;
  IF (length(definition)-length(replace(definition,old_block,'')))/length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile event history block 5';
  END IF;
  EXECUTE replace(definition,old_block,new_block);

END;
$migration$;
REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text) TO service_role;

-- A duplicate acknowledgement is valid only for the same payment/action/order.
-- Preserve existing event and payment locks, entitlement changes and wallet logic.
DO $migration$
DECLARE
  definition text;
  replacement text;
  entry record;
  old_block text := $old$  IF FOUND THEN
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.outcome = 'manual_review' THEN 'manual_review'
        ELSE 'already_adjusted'
      END,$old$;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('reconcile_marketplace_cash_adjustment', 'marketplace', 'marketplace_orders', 'marketplace_order_id'),
    ('reconcile_post_resource_cash_adjustment', 'post_resource', 'post_resource_bundle_orders', 'post_resource_order_id')
  ) AS paths(function_name, purchase_kind, order_table, order_column)
  LOOP
    SELECT pg_get_functiondef(format('public.%I(text,text,text,text,text)', entry.function_name)::regprocedure)
      INTO definition;
    IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
      RAISE EXCEPTION 'Expected one duplicate acknowledgement in %', entry.function_name;
    END IF;
    replacement := format($new$  IF FOUND THEN
    IF v_existing.provider_payment_id IS DISTINCT FROM v_payment_id
       OR v_existing.action IS DISTINCT FROM v_action THEN
      RETURN jsonb_build_object('status', 'event_conflict');
    END IF;
    -- The HTTP dispatcher tries marketplace first. A genuine bundle replay
    -- must reach the bundle function so that its order binding is also checked.
    IF v_existing.purchase_kind <> %L THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF v_provider_order_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.%I AS orders
      WHERE orders.id = v_existing.%I
        AND orders.razorpay_order_id = v_provider_order_id
    ) THEN
      RETURN jsonb_build_object('status', 'order_conflict');
    END IF;
    RETURN jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.outcome = 'manual_review' THEN 'manual_review'
        ELSE 'already_adjusted'
      END,$new$, entry.purchase_kind, entry.order_table, entry.order_column);
    EXECUTE replace(definition, old_block, replacement);
  END LOOP;
END;
$migration$;

REVOKE ALL ON FUNCTION public.reconcile_marketplace_cash_adjustment(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_marketplace_cash_adjustment(text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_post_resource_cash_adjustment(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_post_resource_cash_adjustment(text,text,text,text,text) TO service_role;

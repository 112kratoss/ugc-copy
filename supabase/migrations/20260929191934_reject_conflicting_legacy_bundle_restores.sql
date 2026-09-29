-- A restored legacy bundle purchase must own the entitlement it marks active.
-- A different owner order aborts the whole statement; the webhook returns 503
-- without consuming the restore event or leaving a paid order without access.
DO $migration$
DECLARE
  definition text;
  old_block text := $old$        WHERE id = v_bundle.id;
        v_status := 'restored';
      ELSE
        v_status := 'already_active';
      END IF;$old$;
  new_block text := $new$        WHERE id = v_bundle.id;
        v_status := 'restored';
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM public.post_resource_bundle_purchases
          WHERE bundle_id = v_bundle.id
            AND buyer_user_id = p_user_id
            AND order_id = v_bundle_order.id
        ) THEN
          RAISE EXCEPTION 'Mobile restoration conflicts with another purchase';
        END IF;
        v_status := 'already_active';
      END IF;$new$;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one legacy bundle restoration conflict block';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END;
$migration$;
-- Match settlement's resource-before-entitlement lock order. Otherwise a
-- repurchase can hold the asset and wait for a restoring entitlement while
-- restoration holds that entitlement and waits for the asset counter update.
DO $migration$
DECLARE
  definition text;
  old_block text := $old$  ELSIF v_ledger.entitlement_type = 'marketplace_unlock' THEN
    SELECT * INTO v_marketplace_order$old$;
  new_block text := $new$  ELSIF v_ledger.entitlement_type = 'marketplace_unlock' THEN
    PERFORM 1 FROM public.marketplace_assets
    WHERE id = v_ledger.resource_id
    FOR UPDATE;

    SELECT * INTO v_marketplace_order$new$;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one marketplace resource lock block';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END;
$migration$;
REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) TO service_role;

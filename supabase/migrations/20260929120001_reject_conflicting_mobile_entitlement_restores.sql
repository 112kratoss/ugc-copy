-- A restored marketplace purchase must own the entitlement it marks active.
-- A different owner order aborts the whole statement; the webhook returns 503
-- without consuming the restore event or leaving a paid order without access.
DO $migration$
DECLARE
  definition text;
  old_block text := $old$      IF v_purchase_id IS NOT NULL THEN
        UPDATE public.marketplace_assets
        SET sales_count = sales_count + 1,
            earnings_usd_cents = earnings_usd_cents + v_ledger.amount_subunits,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_ledger.resource_id;
        v_status := 'restored';
      ELSE
        v_status := 'already_active';
      END IF;$old$;
  new_block text := $new$      IF v_purchase_id IS NOT NULL THEN
        UPDATE public.marketplace_assets
        SET sales_count = sales_count + 1,
            earnings_usd_cents = earnings_usd_cents + v_ledger.amount_subunits,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_ledger.resource_id;
        v_status := 'restored';
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM public.marketplace_purchases
          WHERE asset_id = v_ledger.resource_id
            AND buyer_user_id = p_user_id
            AND order_id = v_marketplace_order.id
        ) THEN
          RAISE EXCEPTION 'Mobile restoration conflicts with another purchase';
        END IF;
        v_status := 'already_active';
      END IF;$new$;
BEGIN
  SELECT pg_get_functiondef('public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one marketplace restoration conflict block';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END;
$migration$;
REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) TO service_role;

-- A store refund reverses the purchase it refunds, on the account that received it, whichever app
-- user RevenueCat names on the event (security audit, 2026-11-27).
--
-- reconcile_mobile_purchase_adjustment compared the event's app_user_id with the ledger's owner and
-- answered identity_mismatch when they differed, which the RevenueCat webhook acknowledges with a
-- 200 (src/lib/revenuecat-webhook-route-adapter-service.ts). RevenueCat moves a receipt to another
-- app user on a restore (its default transfer behaviour), and a guest's receipt follows the guest
-- into the account it links to, so the refund of such a purchase arrived under the new app user and
-- changed nothing: the store returned the money and the credits stayed. A buyer could do it on
-- purpose (buy as A, restore as B, ask the store for a refund).
--
-- The purchase now settles on the ledger's owner, the account the credits or the unlock went to;
-- the user the event names is reported (event_user_is_owner) and decides nothing. The webhook is
-- authenticated by its shared secret and the receipt is found by its store transaction, and the
-- product must still match. Balance changes on a guest that has linked into an account are
-- forwarded to the account by profiles_forward_linked_credit_change, as for every later charge.
--
-- The body is the live definition (pg_get_functiondef on production and on a clean replay agreed,
-- md5 7f1f0b5db5fdcc6ac18cc6b30d33f8a6) with only the identity block and the answer changed.
-- supabase/tests/database/mobile_refund_follows_ledger_owner.test.sql holds the new behaviour.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.reconcile_mobile_purchase_adjustment(p_external_order_id text, p_user_id uuid, p_product_id text, p_event_id text, p_event_timestamp_ms bigint, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ledger public.mobile_store_transactions%ROWTYPE;
  v_event public.mobile_purchase_adjustment_events%ROWTYPE;
  v_credit_adjustment jsonb;
  v_marketplace_order public.marketplace_orders%ROWTYPE;
  v_bundle_order public.post_resource_bundle_orders%ROWTYPE;
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_purchase_id uuid;
  v_changed integer := 0;
  v_status text;
  v_owner uuid;
  v_event_user_id uuid := p_user_id;
BEGIN
  IF p_action IS NULL
     OR p_action NOT IN ('refund', 'restore')
     OR p_external_order_id IS NULL
     OR p_external_order_id NOT LIKE 'mobile\_%' ESCAPE '\'
     OR nullif(btrim(coalesce(p_product_id, '')), '') IS NULL
     OR nullif(btrim(coalesce(p_event_id, '')), '') IS NULL
     OR p_event_timestamp_ms IS NULL
     OR p_event_timestamp_ms <= 0 THEN
    RAISE EXCEPTION 'invalid mobile purchase adjustment event';
  END IF;

  p_event_id := btrim(p_event_id);
  -- One global provider-event lock precedes receipt locks. Concurrent deliveries
  -- to different receipts must see the winner before touching entitlements.
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile_adjustment_event:' || p_event_id, 0));

  SELECT * INTO v_ledger
  FROM public.mobile_store_transactions
  WHERE external_order_id = p_external_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
  END IF;
  -- The purchase settles on the account that received it, the ledger's owner, whichever app user
  -- the event names. RevenueCat moves a receipt to another app user on a restore, and a guest's
  -- receipt follows the guest into the account it links to; the refund then arrives under the new
  -- app user. The event is authenticated by the webhook's secret and bound to this receipt by its
  -- store transaction and product, so the user it names decides nothing here. Answering
  -- identity_mismatch for it let a store refund leave the credits in place (security audit,
  -- 2026-11-27). A non-credit purchase whose buyer is gone has nobody to settle on.
  v_owner := coalesce(v_ledger.user_id, CASE WHEN v_ledger.entitlement_type = 'credits' THEN v_ledger.detached_user_id END);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('status', 'identity_mismatch', 'rewards', '[]'::jsonb);
  END IF;
  p_user_id := v_owner;
  IF v_ledger.product_id <> p_product_id THEN
    IF v_ledger.product_id LIKE 'legacy.%' THEN
      RETURN jsonb_build_object(
        'status', 'legacy_product_unbound',
        'entitlement_type', v_ledger.entitlement_type,
        'amount_subunits', v_ledger.amount_subunits,
        'currency', v_ledger.currency,
        'rewards', '[]'::jsonb
      );
    END IF;
    RETURN jsonb_build_object('status', 'identity_mismatch', 'rewards', '[]'::jsonb);
  END IF;
  SELECT * INTO v_event FROM public.mobile_purchase_adjustment_events
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
  END IF;
  IF v_ledger.provider_event_timestamp_ms IS NOT NULL
     AND p_event_timestamp_ms < v_ledger.provider_event_timestamp_ms THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
  END IF;

  IF v_event.provider_event_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;

  IF v_ledger.entitlement_type = 'credits' THEN
    v_credit_adjustment := public.reconcile_mobile_credit_purchase_adjustment(
      p_external_order_id,
      p_user_id,
      p_product_id,
      p_event_id,
      p_event_timestamp_ms,
      p_action
    );
    IF coalesce(v_credit_adjustment ->> 'status', '') NOT IN (
      'refunded', 'already_refunded', 'restored', 'already_active'
    ) THEN
      RETURN v_credit_adjustment;
    END IF;
    v_status := v_credit_adjustment ->> 'status';
  ELSIF v_ledger.entitlement_type = 'marketplace_unlock' THEN
    PERFORM 1 FROM public.marketplace_assets
    WHERE id = v_ledger.resource_id
    FOR UPDATE;

    SELECT * INTO v_marketplace_order
    FROM public.marketplace_orders
    WHERE id = v_ledger.source_record_id
      AND buyer_user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
    END IF;

    IF p_action = 'refund' THEN
      DELETE FROM public.marketplace_purchases
      WHERE order_id = v_marketplace_order.id;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed > 0 THEN
        UPDATE public.marketplace_assets
        SET sales_count = greatest(0, sales_count - 1),
            earnings_usd_cents = greatest(0, earnings_usd_cents - v_ledger.amount_subunits),
            updated_at = timezone('utc'::text, now())
        WHERE id = v_ledger.resource_id;
      END IF;
      UPDATE public.marketplace_orders
      SET status = 'failed', updated_at = timezone('utc'::text, now())
      WHERE id = v_marketplace_order.id;
      v_status := CASE WHEN v_changed > 0 THEN 'refunded' ELSE 'already_refunded' END;
    ELSE
      UPDATE public.marketplace_orders
      SET status = 'paid', updated_at = timezone('utc'::text, now())
      WHERE id = v_marketplace_order.id;
      INSERT INTO public.marketplace_purchases (
        asset_id,
        buyer_user_id,
        order_id,
        price_usd_cents,
        amount_subunits,
        currency
      )
      VALUES (
        v_ledger.resource_id,
        p_user_id,
        v_marketplace_order.id,
        v_ledger.amount_subunits,
        v_ledger.amount_subunits,
        v_ledger.currency
      )
      ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
      RETURNING id INTO v_purchase_id;
      IF v_purchase_id IS NOT NULL THEN
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
      END IF;
    END IF;
  ELSE
    SELECT * INTO v_bundle_order
    FROM public.post_resource_bundle_orders
    WHERE id = v_ledger.source_record_id
      AND buyer_user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
    END IF;
    SELECT * INTO v_bundle
    FROM public.post_resource_bundles
    WHERE post_id = v_ledger.resource_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
    END IF;

    IF p_action = 'refund' THEN
      DELETE FROM public.post_resource_bundle_purchases
      WHERE order_id = v_bundle_order.id;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed > 0 THEN
        UPDATE public.post_resource_bundles
        SET sales_count = greatest(0, sales_count - 1),
            earnings_usd_cents = greatest(0, earnings_usd_cents - v_ledger.amount_subunits),
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bundle.id;
      END IF;
      UPDATE public.post_resource_bundle_orders
      SET status = 'failed', updated_at = timezone('utc'::text, now())
      WHERE id = v_bundle_order.id;
      v_status := CASE WHEN v_changed > 0 THEN 'refunded' ELSE 'already_refunded' END;
    ELSE
      UPDATE public.post_resource_bundle_orders
      SET status = 'paid', updated_at = timezone('utc'::text, now())
      WHERE id = v_bundle_order.id;
      INSERT INTO public.post_resource_bundle_purchases (
        bundle_id,
        buyer_user_id,
        order_id,
        price_usd_cents,
        amount_subunits,
        currency
      )
      VALUES (
        v_bundle.id,
        p_user_id,
        v_bundle_order.id,
        v_ledger.amount_subunits,
        v_ledger.amount_subunits,
        v_ledger.currency
      )
      ON CONFLICT (bundle_id, buyer_user_id) DO NOTHING
      RETURNING id INTO v_purchase_id;
      IF v_purchase_id IS NOT NULL THEN
        UPDATE public.post_resource_bundles
        SET sales_count = sales_count + 1,
            earnings_usd_cents = earnings_usd_cents + v_ledger.amount_subunits,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bundle.id;
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
      END IF;
    END IF;
  END IF;

  -- Record only successfully resolved adjustments, atomically with their effects.
  -- Not-found, stale and failed restores do not reserve an event or block retry.
  INSERT INTO public.mobile_purchase_adjustment_events
    (provider_event_id, mobile_store_transaction_id, action, provider_event_timestamp_ms)
  VALUES (p_event_id, v_ledger.id, p_action, p_event_timestamp_ms);

  UPDATE public.mobile_store_transactions
  SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'active' END,
      provider_event_id = p_event_id,
      provider_event_timestamp_ms = p_event_timestamp_ms
  WHERE id = v_ledger.id;

  UPDATE public.mobile_purchase_intents
  SET status = CASE WHEN p_action = 'refund' THEN 'revoked' ELSE 'consumed' END
  WHERE id = v_ledger.purchase_intent_id;

  RETURN jsonb_build_object(
    'status', v_status,
    'entitlement_type', v_ledger.entitlement_type,
    'event_user_is_owner', v_event_user_id IS NOT DISTINCT FROM v_owner,
    'rewards', coalesce(v_credit_adjustment -> 'rewards', '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) TO service_role;

COMMIT;

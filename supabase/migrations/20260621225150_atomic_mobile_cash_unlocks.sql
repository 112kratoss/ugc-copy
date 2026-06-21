CREATE OR REPLACE FUNCTION public.complete_mobile_marketplace_purchase(
  p_user_id uuid,
  p_asset_id uuid,
  p_external_order_id text,
  p_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset public.marketplace_assets%ROWTYPE;
  v_order public.marketplace_orders%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_external_order_id), '') IS NULL OR nullif(btrim(p_payment_id), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_order');
  END IF;

  SELECT *
  INTO v_asset
  FROM public.marketplace_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_asset.seller_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  IF v_asset.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.marketplace_purchases
    WHERE asset_id = v_asset.id
      AND buyer_user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  INSERT INTO public.marketplace_orders (
    asset_id,
    buyer_user_id,
    razorpay_order_id,
    razorpay_payment_id,
    amount_subunits,
    currency,
    status
  )
  VALUES (
    v_asset.id,
    p_user_id,
    p_external_order_id,
    p_payment_id,
    v_asset.price_usd_cents,
    'USD',
    'paid'
  )
  ON CONFLICT (razorpay_order_id) DO NOTHING;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_order_id = p_external_order_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_order.asset_id IS DISTINCT FROM v_asset.id
     OR v_order.buyer_user_id IS DISTINCT FROM p_user_id
     OR v_order.currency IS DISTINCT FROM 'USD' THEN
    RETURN jsonb_build_object(
      'status', 'order_conflict',
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  IF v_order.status <> 'paid' OR v_order.razorpay_payment_id IS DISTINCT FROM p_payment_id THEN
    UPDATE public.marketplace_orders
    SET status = 'paid',
        razorpay_payment_id = p_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id;
  END IF;

  INSERT INTO public.marketplace_purchases (
    asset_id,
    buyer_user_id,
    order_id,
    price_usd_cents,
    amount_subunits,
    currency
  )
  VALUES (
    v_asset.id,
    p_user_id,
    v_order.id,
    v_asset.price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_asset.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'asset_id', v_asset.id,
    'seller_user_id', v_asset.seller_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_mobile_post_resource_purchase(
  p_user_id uuid,
  p_post_id uuid,
  p_external_order_id text,
  p_payment_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_order public.post_resource_bundle_orders%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_external_order_id), '') IS NULL OR nullif(btrim(p_payment_id), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_order');
  END IF;

  SELECT *
  INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_bundle.owner_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases
    WHERE bundle_id = v_bundle.id
      AND buyer_user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  INSERT INTO public.post_resource_bundle_orders (
    bundle_id,
    buyer_user_id,
    razorpay_order_id,
    razorpay_payment_id,
    amount_subunits,
    currency,
    status
  )
  VALUES (
    v_bundle.id,
    p_user_id,
    p_external_order_id,
    p_payment_id,
    v_bundle.price_usd_cents,
    'USD',
    'paid'
  )
  ON CONFLICT (razorpay_order_id) DO NOTHING;

  SELECT *
  INTO v_order
  FROM public.post_resource_bundle_orders
  WHERE razorpay_order_id = p_external_order_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_order.bundle_id IS DISTINCT FROM v_bundle.id
     OR v_order.buyer_user_id IS DISTINCT FROM p_user_id
     OR v_order.currency IS DISTINCT FROM 'USD' THEN
    RETURN jsonb_build_object(
      'status', 'order_conflict',
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  IF v_order.status <> 'paid' OR v_order.razorpay_payment_id IS DISTINCT FROM p_payment_id THEN
    UPDATE public.post_resource_bundle_orders
    SET status = 'paid',
        razorpay_payment_id = p_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id;
  END IF;

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
    v_order.id,
    v_bundle.price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (bundle_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id
    );
  END IF;

  UPDATE public.post_resource_bundles
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_bundle.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_bundle.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'post_id', v_bundle.post_id,
    'bundle_id', v_bundle.id,
    'owner_user_id', v_bundle.owner_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_marketplace_purchase(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_post_resource_purchase(uuid, uuid, text, text) TO service_role;

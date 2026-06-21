CREATE OR REPLACE FUNCTION public.unlock_marketplace_asset_with_credits(
  p_user_id uuid,
  p_asset_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset public.marketplace_assets%ROWTYPE;
  v_credits integer;
  v_order_id uuid;
  v_order_reference text;
  v_payment_reference text;
BEGIN
  SELECT *
  INTO v_asset
  FROM public.marketplace_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT credits
  INTO v_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_asset.seller_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'remaining_credits', v_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  IF v_asset.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'remaining_credits', v_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
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
      'remaining_credits', v_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  IF v_credits < v_asset.price_usd_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'asset_id', v_asset.id,
      'seller_user_id', v_asset.seller_user_id,
      'credit_cost', v_asset.price_usd_cents
    );
  END IF;

  v_order_reference := 'credits_asset_' || v_asset.id::text || '_' || p_user_id::text;
  v_payment_reference := 'credits_unlock_' || v_asset.id::text || '_' || p_user_id::text;

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
    v_order_reference,
    v_payment_reference,
    v_asset.price_usd_cents,
    'USD',
    'paid'
  )
  ON CONFLICT (razorpay_order_id) DO UPDATE
  SET
    razorpay_payment_id = EXCLUDED.razorpay_payment_id,
    amount_subunits = EXCLUDED.amount_subunits,
    currency = EXCLUDED.currency,
    status = 'paid',
    updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_order_id;

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
    v_order_id,
    v_asset.price_usd_cents,
    v_asset.price_usd_cents,
    'USD'
  );

  UPDATE public.profiles
  SET credits = credits - v_asset.price_usd_cents
  WHERE id = p_user_id;

  UPDATE public.marketplace_assets
  SET
    sales_count = sales_count + 1,
    earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
    updated_at = timezone('utc'::text, now())
  WHERE id = v_asset.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'remaining_credits', v_credits - v_asset.price_usd_cents,
    'asset_id', v_asset.id,
    'seller_user_id', v_asset.seller_user_id,
    'credit_cost', v_asset.price_usd_cents
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_post_resource_bundle_with_credits(
  p_user_id uuid,
  p_post_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_credits integer;
  v_order_id uuid;
  v_order_reference text;
  v_payment_reference text;
BEGIN
  SELECT *
  INTO v_bundle
  FROM public.post_resource_bundles
  WHERE post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND OR v_bundle.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT credits
  INTO v_credits
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'profile_not_found');
  END IF;

  IF v_bundle.owner_user_id = p_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'remaining_credits', v_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents <= 0 THEN
    RETURN jsonb_build_object(
      'status', 'not_paid',
      'remaining_credits', v_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
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
      'remaining_credits', v_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  IF v_credits < v_bundle.price_usd_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_credits',
      'remaining_credits', v_credits,
      'post_id', v_bundle.post_id,
      'bundle_id', v_bundle.id,
      'owner_user_id', v_bundle.owner_user_id,
      'credit_cost', v_bundle.price_usd_cents
    );
  END IF;

  v_order_reference := 'credits_bundle_' || v_bundle.id::text || '_' || p_user_id::text;
  v_payment_reference := 'credits_unlock_' || v_bundle.id::text || '_' || p_user_id::text;

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
    v_order_reference,
    v_payment_reference,
    v_bundle.price_usd_cents,
    'USD',
    'paid'
  )
  ON CONFLICT (razorpay_order_id) DO UPDATE
  SET
    razorpay_payment_id = EXCLUDED.razorpay_payment_id,
    amount_subunits = EXCLUDED.amount_subunits,
    currency = EXCLUDED.currency,
    status = 'paid',
    updated_at = timezone('utc'::text, now())
  RETURNING id INTO v_order_id;

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
    v_order_id,
    v_bundle.price_usd_cents,
    v_bundle.price_usd_cents,
    'USD'
  );

  UPDATE public.profiles
  SET credits = credits - v_bundle.price_usd_cents
  WHERE id = p_user_id;

  UPDATE public.post_resource_bundles
  SET
    sales_count = sales_count + 1,
    earnings_usd_cents = earnings_usd_cents + v_bundle.price_usd_cents,
    updated_at = timezone('utc'::text, now())
  WHERE id = v_bundle.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'remaining_credits', v_credits - v_bundle.price_usd_cents,
    'post_id', v_bundle.post_id,
    'bundle_id', v_bundle.id,
    'owner_user_id', v_bundle.owner_user_id,
    'credit_cost', v_bundle.price_usd_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_marketplace_asset_with_credits(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_post_resource_bundle_with_credits(uuid, uuid) TO service_role;

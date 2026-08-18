-- Money integrity fixes (2026-08 money audit).
--
-- 1. `transactions` gains an explicit `currency` column. Web Razorpay credit
--    orders and mobile credit settlements both land in this ledger; until now
--    the currency was an implicit "INR" assumption hardcoded in the admin
--    revenue report. The column defaults to INR, which is also the correct
--    backfill for every historical row (web billing is INR-only and mobile
--    settlements record the catalog's nominal INR price).
-- 2. Free marketplace unlocks become atomic. The previous app-side path did a
--    read-then-write dance (orders insert, then complete_marketplace_purchase)
--    with three unrelated random ids; two concurrent requests could both pass
--    the ownership check and strand a duplicate order. The new
--    `unlock_free_marketplace_asset` mirrors `unlock_free_post_resource_bundle`:
--    one row lock, constraint-backed dedupe, consistent order/payment
--    references. `prune_abandoned_free_unlock_orders` learns to sweep the
--    marketplace rail's legacy strands for cleanup parity.
-- 3. `mobile_store_transactions` gains nullable `store_reported_price` /
--    `store_reported_currency`. The ledger's `amount_subunits` is the
--    catalog's nominal INR list price, not what the store actually charged;
--    RevenueCat webhook purchase events carry the store-reported price, and
--    settlement now persists it as evidence (never as pricing authority).
-- 4. `creator_payout_requests.payout_details` (UPI / bank contact details) is
--    now written as AES-256-GCM ciphertext by the app (`enc.v1.` prefix,
--    dot-delimited base64url). The length CHECK and the RPC's validation are
--    relaxed to fit ciphertext; legacy plaintext rows remain readable and the
--    admin queue decrypts with a plaintext fallback.

-- 1. Currency on the credit-purchase ledger. ---------------------------------

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR'
    CHECK (currency ~ '^[A-Z]{3}$');

COMMENT ON COLUMN public.transactions.currency IS
  'ISO 4217 settlement currency. Web Razorpay billing is INR; mobile rows record the catalog''s nominal INR price (see mobile_store_transactions.store_reported_currency for what the store charged).';

-- 3. Store-reported price evidence on the mobile ledger. ---------------------

ALTER TABLE public.mobile_store_transactions
  ADD COLUMN IF NOT EXISTS store_reported_price numeric(12,4)
    CHECK (store_reported_price >= 0),
  ADD COLUMN IF NOT EXISTS store_reported_currency text
    CHECK (store_reported_currency ~ '^[A-Z]{3}$');

ALTER TABLE public.mobile_store_transactions
  DROP CONSTRAINT IF EXISTS mobile_store_transactions_store_reported_pair_check;
ALTER TABLE public.mobile_store_transactions
  ADD CONSTRAINT mobile_store_transactions_store_reported_pair_check
    CHECK ((store_reported_price IS NULL) = (store_reported_currency IS NULL));

COMMENT ON COLUMN public.mobile_store_transactions.store_reported_price IS
  'Price RevenueCat reported for the store transaction, in store_reported_currency major units. Evidence for revenue reporting only; amount_subunits stays the nominal catalog price and the settlement authority.';

-- `complete_mobile_purchase` gains two optional store-reported price params
-- and writes the settlement currency into `transactions`. Postgres would treat
-- a CREATE OR REPLACE with added parameters as a new overload, so the old
-- 7-argument function is dropped first; callers that omit the new arguments
-- keep working through the parameter defaults during the deploy window.

DROP FUNCTION IF EXISTS public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.complete_mobile_purchase(
  p_user_id uuid,
  p_purchase_intent_id uuid,
  p_product_id text,
  p_provider text,
  p_store_transaction_id text,
  p_external_order_id text,
  p_payment_id text,
  p_store_reported_price numeric DEFAULT NULL,
  p_store_reported_currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product public.mobile_store_products%ROWTYPE;
  v_intent public.mobile_purchase_intents%ROWTYPE;
  v_ledger public.mobile_store_transactions%ROWTYPE;
  v_existing_ledger public.mobile_store_transactions%ROWTYPE;
  v_credit_transaction public.transactions%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
  v_marketplace_order public.marketplace_orders%ROWTYPE;
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_bundle_order public.post_resource_bundle_orders%ROWTYPE;
  v_purchase_id uuid;
  v_source_record_id uuid;
  v_remaining_credits integer;
  v_auto_intent boolean := false;
  v_entitlement_type text;
  v_resource_id uuid;
  v_amount integer;
  v_currency text;
  v_credits integer;
  v_seller_user_id uuid;
  v_owner_user_id uuid;
  v_bundle_id uuid;
  v_store_reported_price numeric;
  v_store_reported_currency text;
BEGIN
  IF p_user_id IS NULL
     OR nullif(btrim(coalesce(p_product_id, '')), '') IS NULL
     OR p_provider IS NULL
     OR p_provider NOT IN ('app_store', 'play_store', 'revenuecat', 'sandbox')
     OR nullif(btrim(coalesce(p_store_transaction_id, '')), '') IS NULL
     OR p_external_order_id IS NULL
     OR p_external_order_id NOT LIKE 'mobile\_%' ESCAPE '\'
     OR nullif(btrim(coalesce(p_payment_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  -- The store-reported price is evidence from the RevenueCat webhook, not an
  -- authority. Malformed pairs degrade to NULL instead of failing settlement.
  IF p_store_reported_price IS NOT NULL
     AND p_store_reported_price >= 0
     AND p_store_reported_currency ~ '^[A-Z]{3}$' THEN
    v_store_reported_price := p_store_reported_price;
    v_store_reported_currency := p_store_reported_currency;
  END IF;

  SELECT * INTO v_existing_ledger
  FROM public.mobile_store_transactions
  WHERE provider = p_provider
    AND store_transaction_id = p_store_transaction_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_ledger.external_order_id <> p_external_order_id
       OR v_existing_ledger.user_id IS DISTINCT FROM p_user_id
       OR v_existing_ledger.product_id <> p_product_id
       OR (
         p_purchase_intent_id IS NOT NULL
         AND v_existing_ledger.purchase_intent_id <> p_purchase_intent_id
       ) THEN
      RETURN jsonb_build_object('status', 'transaction_conflict');
    END IF;
    IF v_existing_ledger.status = 'revoked' THEN
      RETURN jsonb_build_object('status', 'revoked');
    END IF;

    IF v_existing_ledger.entitlement_type = 'credits' THEN
      SELECT credits INTO v_remaining_credits
      FROM public.profiles WHERE id = p_user_id;
    ELSIF v_existing_ledger.entitlement_type = 'marketplace_unlock' THEN
      SELECT seller_user_id INTO v_seller_user_id
      FROM public.marketplace_assets WHERE id = v_existing_ledger.resource_id;
    ELSE
      SELECT id, owner_user_id INTO v_bundle_id, v_owner_user_id
      FROM public.post_resource_bundles WHERE post_id = v_existing_ledger.resource_id;
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_processed',
      'entitlement_type', v_existing_ledger.entitlement_type,
      'product_id', v_existing_ledger.product_id,
      'resource_id', v_existing_ledger.resource_id,
      'amount_subunits', v_existing_ledger.amount_subunits,
      'currency', v_existing_ledger.currency,
      'credits', v_existing_ledger.credits,
      'remaining_credits', v_remaining_credits,
      'source_record_id', v_existing_ledger.source_record_id,
      'seller_user_id', v_seller_user_id,
      'owner_user_id', v_owner_user_id,
      'bundle_id', v_bundle_id
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.mobile_store_transactions
    WHERE external_order_id = p_external_order_id
  ) THEN
    RETURN jsonb_build_object('status', 'transaction_conflict');
  END IF;

  IF p_purchase_intent_id IS NULL THEN
    SELECT * INTO v_product
    FROM public.mobile_store_products
    WHERE product_id = p_product_id
      AND entitlement_type = 'credits'
      AND active = true;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'product_not_found');
    END IF;

    INSERT INTO public.mobile_purchase_intents (
      user_id,
      product_id,
      entitlement_type,
      resource_id,
      amount_subunits,
      currency,
      credits
    )
    VALUES (
      p_user_id,
      v_product.product_id,
      v_product.entitlement_type,
      NULL,
      v_product.amount_subunits,
      v_product.currency,
      v_product.credits
    )
    RETURNING * INTO v_intent;
    v_auto_intent := true;
  ELSE
    SELECT * INTO v_intent
    FROM public.mobile_purchase_intents
    WHERE id = p_purchase_intent_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'intent_not_found');
    END IF;
    IF v_intent.product_id <> p_product_id THEN
      RETURN jsonb_build_object('status', 'intent_mismatch');
    END IF;
    IF v_intent.status = 'consumed' THEN
      RETURN jsonb_build_object('status', 'intent_consumed');
    END IF;
    IF v_intent.status = 'revoked' THEN
      RETURN jsonb_build_object('status', 'intent_revoked');
    END IF;
    IF v_intent.status = 'expired' OR v_intent.expires_at <= timezone('utc'::text, now()) THEN
      UPDATE public.mobile_purchase_intents SET status = 'expired'
      WHERE id = v_intent.id;
      RETURN jsonb_build_object('status', 'intent_expired');
    END IF;
  END IF;

  v_entitlement_type := v_intent.entitlement_type;
  v_resource_id := v_intent.resource_id;
  v_amount := v_intent.amount_subunits;
  v_currency := v_intent.currency;
  v_credits := v_intent.credits;

  IF v_entitlement_type = 'marketplace_unlock' THEN
    SELECT * INTO v_asset
    FROM public.marketplace_assets
    WHERE id = v_resource_id
    FOR UPDATE;

    IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
      RETURN jsonb_build_object('status', 'resource_not_found');
    END IF;
    IF v_asset.seller_user_id = p_user_id THEN
      RETURN jsonb_build_object('status', 'owned_by_user');
    END IF;
    -- The unexpired intent is the locked server quote. A seller price change
    -- after store checkout starts must not strand an already-paid buyer.
    IF EXISTS (
      SELECT 1 FROM public.marketplace_purchases
      WHERE asset_id = v_asset.id AND buyer_user_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('status', 'already_owned');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.marketplace_orders
      WHERE razorpay_order_id = p_external_order_id
    ) THEN
      RETURN jsonb_build_object('status', 'transaction_conflict');
    END IF;
  ELSIF v_entitlement_type = 'post_resource_unlock' THEN
    SELECT * INTO v_bundle
    FROM public.post_resource_bundles
    WHERE post_id = v_resource_id
    FOR UPDATE;

    IF NOT FOUND OR v_bundle.status <> 'published' THEN
      RETURN jsonb_build_object('status', 'resource_not_found');
    END IF;
    IF v_bundle.owner_user_id = p_user_id THEN
      RETURN jsonb_build_object('status', 'owned_by_user');
    END IF;
    -- The catalog-backed intent preserves the exact amount and currency even
    -- if the owner edits the listing while the native purchase is in flight.
    IF EXISTS (
      SELECT 1 FROM public.post_resource_bundle_purchases
      WHERE bundle_id = v_bundle.id AND buyer_user_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('status', 'already_owned');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.post_resource_bundle_orders
      WHERE razorpay_order_id = p_external_order_id
    ) THEN
      RETURN jsonb_build_object('status', 'transaction_conflict');
    END IF;
  ELSIF v_entitlement_type <> 'credits' THEN
    RETURN jsonb_build_object('status', 'intent_mismatch');
  END IF;

  INSERT INTO public.mobile_store_transactions (
    provider,
    store_transaction_id,
    external_order_id,
    user_id,
    product_id,
    purchase_intent_id,
    entitlement_type,
    resource_id,
    amount_subunits,
    currency,
    credits,
    status,
    store_reported_price,
    store_reported_currency
  )
  VALUES (
    p_provider,
    p_store_transaction_id,
    p_external_order_id,
    p_user_id,
    p_product_id,
    v_intent.id,
    v_entitlement_type,
    v_resource_id,
    v_amount,
    v_currency,
    v_credits,
    'active',
    v_store_reported_price,
    v_store_reported_currency
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_ledger;

  IF NOT FOUND THEN
    IF v_auto_intent THEN
      DELETE FROM public.mobile_purchase_intents WHERE id = v_intent.id;
    END IF;
    SELECT * INTO v_existing_ledger
    FROM public.mobile_store_transactions
    WHERE (provider = p_provider AND store_transaction_id = p_store_transaction_id)
       OR external_order_id = p_external_order_id
    LIMIT 1;
    IF FOUND
       AND v_existing_ledger.user_id IS NOT DISTINCT FROM p_user_id
       AND v_existing_ledger.product_id = p_product_id
       AND v_existing_ledger.entitlement_type = v_entitlement_type
       AND v_existing_ledger.resource_id IS NOT DISTINCT FROM v_resource_id THEN
      RETURN jsonb_build_object(
        'status', 'already_processed',
        'entitlement_type', v_existing_ledger.entitlement_type,
        'product_id', v_existing_ledger.product_id,
        'resource_id', v_existing_ledger.resource_id,
        'amount_subunits', v_existing_ledger.amount_subunits,
        'currency', v_existing_ledger.currency,
        'credits', v_existing_ledger.credits,
        'source_record_id', v_existing_ledger.source_record_id
      );
    END IF;
    RETURN jsonb_build_object(
      'status', CASE WHEN NOT v_auto_intent THEN 'intent_consumed' ELSE 'transaction_conflict' END
    );
  END IF;

  IF v_entitlement_type = 'credits' THEN
    SELECT * INTO v_credit_transaction
    FROM public.transactions
    WHERE razorpay_order_id = p_external_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.transactions (
        user_id,
        razorpay_order_id,
        razorpay_payment_id,
        amount,
        credits,
        status,
        mobile_product_id,
        currency
      )
      VALUES (
        p_user_id,
        p_external_order_id,
        p_payment_id,
        v_amount,
        v_credits,
        'created',
        p_product_id,
        v_currency
      )
      RETURNING * INTO v_credit_transaction;
    ELSIF v_credit_transaction.user_id IS DISTINCT FROM p_user_id
       OR v_credit_transaction.mobile_product_id IS DISTINCT FROM p_product_id
       OR v_credit_transaction.amount <> v_amount
       OR v_credit_transaction.credits <> v_credits THEN
      RAISE EXCEPTION 'mobile credit transaction identity conflict';
    END IF;

    IF v_credit_transaction.status = 'created' THEN
      IF NOT public.add_credits(
        p_user_id,
        v_credits,
        v_credit_transaction.id,
        p_payment_id
      ) THEN
        RAISE EXCEPTION 'mobile credit settlement failed';
      END IF;
    ELSIF v_credit_transaction.status <> 'success' THEN
      RAISE EXCEPTION 'mobile credit transaction is not active';
    END IF;

    v_source_record_id := v_credit_transaction.id;
    SELECT credits INTO v_remaining_credits
    FROM public.profiles WHERE id = p_user_id;
  ELSIF v_entitlement_type = 'marketplace_unlock' THEN
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
      v_amount,
      v_currency,
      'paid'
    )
    RETURNING * INTO v_marketplace_order;

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
      v_marketplace_order.id,
      v_amount,
      v_amount,
      v_currency
    )
    RETURNING id INTO v_purchase_id;

    UPDATE public.marketplace_assets
    SET sales_count = sales_count + 1,
        earnings_usd_cents = earnings_usd_cents + v_amount,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_asset.id;

    v_source_record_id := v_marketplace_order.id;
    v_seller_user_id := v_asset.seller_user_id;
  ELSE
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
      v_amount,
      v_currency,
      'paid'
    )
    RETURNING * INTO v_bundle_order;

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
      v_amount,
      v_amount,
      v_currency
    )
    RETURNING id INTO v_purchase_id;

    UPDATE public.post_resource_bundles
    SET sales_count = sales_count + 1,
        earnings_usd_cents = earnings_usd_cents + v_amount,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_bundle.id;

    v_source_record_id := v_bundle_order.id;
    v_owner_user_id := v_bundle.owner_user_id;
    v_bundle_id := v_bundle.id;
  END IF;

  UPDATE public.mobile_store_transactions
  SET source_record_id = v_source_record_id
  WHERE id = v_ledger.id;

  UPDATE public.mobile_purchase_intents
  SET status = 'consumed',
      consumed_at = timezone('utc'::text, now())
  WHERE id = v_intent.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'entitlement_type', v_entitlement_type,
    'product_id', p_product_id,
    'resource_id', v_resource_id,
    'amount_subunits', v_amount,
    'currency', v_currency,
    'credits', v_credits,
    'remaining_credits', v_remaining_credits,
    'source_record_id', v_source_record_id,
    'seller_user_id', v_seller_user_id,
    'owner_user_id', v_owner_user_id,
    'bundle_id', v_bundle_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)
  TO service_role;

-- 2. Atomic free marketplace unlock. -----------------------------------------

CREATE OR REPLACE FUNCTION public.unlock_free_marketplace_asset(
  p_buyer_user_id uuid,
  p_asset_id uuid,
  p_order_reference text,
  p_payment_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset public.marketplace_assets%ROWTYPE;
  v_order_id uuid;
  v_purchase_id uuid;
BEGIN
  IF p_buyer_user_id IS NULL
    OR p_asset_id IS NULL
    OR nullif(btrim(coalesce(p_order_reference, '')), '') IS NULL
    OR nullif(btrim(coalesce(p_payment_reference, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_asset
  FROM public.marketplace_assets
  WHERE id = p_asset_id
  FOR UPDATE;

  IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_asset.seller_user_id = p_buyer_user_id THEN
    RETURN jsonb_build_object(
      'status', 'owned_by_user',
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  IF v_asset.price_usd_cents <> 0 THEN
    RETURN jsonb_build_object('status', 'not_free');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.marketplace_purchases AS purchases
    WHERE purchases.asset_id = v_asset.id
      AND purchases.buyer_user_id = p_buyer_user_id
  ) THEN
    RETURN jsonb_build_object(
      'status', 'already_owned',
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
  ) VALUES (
    v_asset.id,
    p_buyer_user_id,
    btrim(p_order_reference),
    btrim(p_payment_reference),
    0,
    'USD',
    'paid'
  )
  ON CONFLICT (razorpay_order_id) DO NOTHING
  RETURNING id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RETURN jsonb_build_object('status', 'order_conflict');
  END IF;

  INSERT INTO public.marketplace_purchases (
    asset_id,
    buyer_user_id,
    order_id,
    price_usd_cents,
    amount_subunits,
    currency
  ) VALUES (
    v_asset.id,
    p_buyer_user_id,
    v_order_id,
    0,
    0,
    'USD'
  )
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    -- Lost the (asset_id, buyer_user_id) race: the buyer already owns the
    -- asset through another order. Remove the order this call created so no
    -- entitlement-less free order is left behind.
    DELETE FROM public.marketplace_orders WHERE id = v_order_id;
    RETURN jsonb_build_object(
      'status', 'already_owned',
      'seller_user_id', v_asset.seller_user_id
    );
  END IF;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_asset.id;

  RETURN jsonb_build_object(
    'status', 'completed',
    'seller_user_id', v_asset.seller_user_id,
    'purchase_id', v_purchase_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_free_marketplace_asset(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_free_marketplace_asset(uuid, uuid, text, text)
  TO service_role;

-- Cleanup parity: the sweeper now also removes abandoned free marketplace
-- orders (status 'created', zero amount, no purchase row) left behind by the
-- pre-atomic unlock path. New free unlocks insert orders as 'paid' with the
-- purchase in the same transaction, so only legacy strands ever match.
CREATE OR REPLACE FUNCTION public.prune_abandoned_free_unlock_orders(
  p_older_than interval DEFAULT interval '1 day'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted_bundle integer;
  v_deleted_marketplace integer;
BEGIN
  WITH victims AS (
    SELECT orders.id
    FROM public.post_resource_bundle_orders AS orders
    WHERE orders.status = 'created'
      AND orders.amount_subunits = 0
      AND orders.razorpay_order_id LIKE 'free_bundle_%'
      AND orders.created_at < timezone('utc'::text, now()) - p_older_than
      AND NOT EXISTS (
        SELECT 1 FROM public.post_resource_bundle_purchases AS purchases
        WHERE purchases.order_id = orders.id
      )
    ORDER BY orders.created_at, orders.id LIMIT 5000
    FOR UPDATE OF orders SKIP LOCKED
  )
  DELETE FROM public.post_resource_bundle_orders AS orders
  USING victims WHERE orders.id = victims.id;
  GET DIAGNOSTICS v_deleted_bundle = ROW_COUNT;

  WITH victims AS (
    SELECT orders.id
    FROM public.marketplace_orders AS orders
    WHERE orders.status = 'created'
      AND orders.amount_subunits = 0
      AND orders.razorpay_order_id LIKE 'free\_%' ESCAPE '\'
      AND orders.created_at < timezone('utc'::text, now()) - p_older_than
      AND NOT EXISTS (
        SELECT 1 FROM public.marketplace_purchases AS purchases
        WHERE purchases.order_id = orders.id
      )
    ORDER BY orders.created_at, orders.id LIMIT 5000
    FOR UPDATE OF orders SKIP LOCKED
  )
  DELETE FROM public.marketplace_orders AS orders
  USING victims WHERE orders.id = victims.id;
  GET DIAGNOSTICS v_deleted_marketplace = ROW_COUNT;

  RETURN v_deleted_bundle + v_deleted_marketplace;
END;
$$;

-- 4. Ciphertext-sized payout details. ----------------------------------------

-- AES-256-GCM ciphertext of a 500-character detail string (12-byte IV,
-- 16-byte tag, dot-delimited base64url with an `enc.v1.` prefix) can run to
-- roughly 2.8k characters for worst-case UTF-8 input. 4000 leaves headroom
-- without unbounding the column.
ALTER TABLE public.creator_payout_requests
  DROP CONSTRAINT IF EXISTS creator_payout_requests_payout_details_check;
ALTER TABLE public.creator_payout_requests
  ADD CONSTRAINT creator_payout_requests_payout_details_check
    CHECK (char_length(btrim(payout_details)) BETWEEN 3 AND 4000);

CREATE OR REPLACE FUNCTION public.request_creator_payout(
  p_user_id uuid,
  p_payout_method text,
  p_payout_details text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_minimum_subunits constant bigint := 1000000; -- $100
  v_wallet public.creator_resource_wallets%ROWTYPE;
  v_method text := nullif(btrim(coalesce(p_payout_method, '')), '');
  -- The app encrypts payout details before this RPC (enc.v1. prefix); legacy
  -- rows and non-production fallbacks may still be plaintext. The bound is
  -- therefore the ciphertext bound, not the 500-character plaintext bound the
  -- route enforces before encrypting.
  v_details text := nullif(btrim(coalesce(p_payout_details, '')), '');
  v_request_id uuid;
  v_amount bigint;
BEGIN
  IF v_method IS NULL OR char_length(v_method) < 2 OR char_length(v_method) > 40 THEN
    RETURN jsonb_build_object('status', 'invalid_method');
  END IF;

  IF v_details IS NULL OR char_length(v_details) < 3 OR char_length(v_details) > 4000 THEN
    RETURN jsonb_build_object('status', 'invalid_details');
  END IF;

  SELECT *
  INTO v_wallet
  FROM public.creator_resource_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'below_minimum', 'available_token_subunits', 0);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.creator_payout_requests
    WHERE user_id = p_user_id AND status = 'requested'
  ) THEN
    RETURN jsonb_build_object('status', 'already_pending');
  END IF;

  v_amount := v_wallet.available_token_subunits;

  IF v_amount < v_minimum_subunits THEN
    RETURN jsonb_build_object(
      'status', 'below_minimum',
      'available_token_subunits', v_amount,
      'minimum_token_subunits', v_minimum_subunits
    );
  END IF;

  -- Whole balance, moved to hold under the same lock that read it.
  UPDATE public.creator_resource_wallets
  SET available_token_subunits = 0,
      held_token_subunits = held_token_subunits + v_amount,
      updated_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id;

  INSERT INTO public.creator_payout_requests (
    user_id, amount_token_subunits, payout_method, payout_details
  )
  VALUES (p_user_id, v_amount, v_method, v_details)
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object(
    'status', 'requested',
    'request_id', v_request_id,
    'amount_token_subunits', v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.request_creator_payout(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_creator_payout(uuid, text, text)
  TO service_role;

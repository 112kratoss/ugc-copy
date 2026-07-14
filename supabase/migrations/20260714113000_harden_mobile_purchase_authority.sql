-- Make mobile store settlement server-authoritative and globally idempotent.

CREATE TABLE IF NOT EXISTS public.mobile_store_products (
  product_id text PRIMARY KEY CHECK (btrim(product_id) <> ''),
  entitlement_type text NOT NULL
    CHECK (entitlement_type IN ('credits', 'marketplace_unlock', 'post_resource_unlock')),
  amount_subunits integer NOT NULL CHECK (amount_subunits > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credits integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT mobile_store_products_credit_shape_check CHECK (
    (entitlement_type = 'credits' AND credits IS NOT NULL AND credits > 0)
    OR (entitlement_type <> 'credits' AND credits IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.mobile_purchase_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Keep the immutable purchase snapshot after account deletion, but remove
  -- the auth identity link. New intents still require a non-null user through
  -- the service-only creation functions below.
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  product_id text NOT NULL CHECK (btrim(product_id) <> ''),
  entitlement_type text NOT NULL
    CHECK (entitlement_type IN ('credits', 'marketplace_unlock', 'post_resource_unlock')),
  resource_id uuid,
  amount_subunits integer NOT NULL CHECK (amount_subunits > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credits integer,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc'::text, now()) + interval '30 minutes'),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT mobile_purchase_intents_shape_check CHECK (
    (entitlement_type = 'credits' AND resource_id IS NULL AND credits IS NOT NULL AND credits > 0)
    OR (entitlement_type <> 'credits' AND resource_id IS NOT NULL AND credits IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.mobile_store_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL
    CHECK (provider IN ('app_store', 'play_store', 'revenuecat', 'sandbox')),
  store_transaction_id text NOT NULL CHECK (btrim(store_transaction_id) <> ''),
  external_order_id text NOT NULL UNIQUE CHECK (external_order_id LIKE 'mobile\_%' ESCAPE '\'),
  -- Financial settlement evidence survives account deletion in anonymized
  -- form instead of preventing auth.users from being deleted.
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  product_id text NOT NULL CHECK (btrim(product_id) <> ''),
  purchase_intent_id uuid NOT NULL UNIQUE
    REFERENCES public.mobile_purchase_intents(id) ON DELETE RESTRICT,
  entitlement_type text NOT NULL
    CHECK (entitlement_type IN ('credits', 'marketplace_unlock', 'post_resource_unlock')),
  resource_id uuid,
  amount_subunits integer NOT NULL CHECK (amount_subunits > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credits integer,
  source_record_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  provider_event_id text,
  provider_event_timestamp_ms bigint,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  UNIQUE (store_transaction_id),
  UNIQUE (provider, store_transaction_id),
  CONSTRAINT mobile_store_transactions_shape_check CHECK (
    (entitlement_type = 'credits' AND resource_id IS NULL AND credits IS NOT NULL AND credits > 0)
    OR (entitlement_type <> 'credits' AND resource_id IS NOT NULL AND credits IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS mobile_purchase_intents_user_created_idx
  ON public.mobile_purchase_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mobile_purchase_intents_pending_expiry_idx
  ON public.mobile_purchase_intents (expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mobile_store_transactions_user_created_idx
  ON public.mobile_store_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mobile_store_transactions_product_idx
  ON public.mobile_store_transactions (product_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mobile_store_products_one_active_tier_idx
  ON public.mobile_store_products (entitlement_type, amount_subunits, currency)
  WHERE active = true;

ALTER TABLE public.mobile_store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_purchase_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_store_transactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mobile_store_products FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mobile_purchase_intents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.mobile_store_transactions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.mobile_store_products TO service_role;
GRANT SELECT ON TABLE public.mobile_purchase_intents TO service_role;
GRANT SELECT ON TABLE public.mobile_store_transactions TO service_role;

CREATE OR REPLACE FUNCTION public.protect_mobile_store_product_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF ROW(
    OLD.product_id,
    OLD.entitlement_type,
    OLD.amount_subunits,
    OLD.currency,
    OLD.credits,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.product_id,
    NEW.entitlement_type,
    NEW.amount_subunits,
    NEW.currency,
    NEW.credits,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'mobile store product authority is immutable';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mobile_store_products_protect_authority
  ON public.mobile_store_products;
CREATE TRIGGER mobile_store_products_protect_authority
BEFORE UPDATE ON public.mobile_store_products
FOR EACH ROW EXECUTE FUNCTION public.protect_mobile_store_product_authority();

CREATE OR REPLACE FUNCTION public.protect_mobile_purchase_intent_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.product_id IS DISTINCT FROM NEW.product_id AND NOT (
    OLD.product_id LIKE 'legacy.%'
    AND EXISTS (
      SELECT 1
      FROM public.mobile_store_products products
      WHERE products.product_id = NEW.product_id
        AND products.entitlement_type = OLD.entitlement_type
        AND products.amount_subunits = OLD.amount_subunits
        AND products.currency = OLD.currency
        AND products.credits IS NOT DISTINCT FROM OLD.credits
    )
  ) THEN
    RAISE EXCEPTION 'mobile purchase intent product authority is immutable';
  END IF;

  -- The auth.users foreign key is allowed to anonymize an intent exactly once.
  -- Direct client writes are revoked, and no service RPC exposes this update.
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL) THEN
    RAISE EXCEPTION 'mobile purchase intent user identity is immutable';
  END IF;

  IF ROW(
    OLD.entitlement_type,
    OLD.resource_id,
    OLD.amount_subunits,
    OLD.currency,
    OLD.credits,
    OLD.expires_at,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.entitlement_type,
    NEW.resource_id,
    NEW.amount_subunits,
    NEW.currency,
    NEW.credits,
    NEW.expires_at,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'mobile purchase intent authority is immutable';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mobile_purchase_intents_protect_authority
  ON public.mobile_purchase_intents;
CREATE TRIGGER mobile_purchase_intents_protect_authority
BEFORE UPDATE ON public.mobile_purchase_intents
FOR EACH ROW EXECUTE FUNCTION public.protect_mobile_purchase_intent_authority();

CREATE OR REPLACE FUNCTION public.protect_mobile_store_transaction_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.product_id IS DISTINCT FROM NEW.product_id AND NOT (
    OLD.product_id LIKE 'legacy.%'
    AND EXISTS (
      SELECT 1
      FROM public.mobile_store_products products
      WHERE products.product_id = NEW.product_id
        AND products.entitlement_type = OLD.entitlement_type
        AND products.amount_subunits = OLD.amount_subunits
        AND products.currency = OLD.currency
        AND products.credits IS NOT DISTINCT FROM OLD.credits
    )
  ) THEN
    RAISE EXCEPTION 'mobile store transaction product identity is immutable';
  END IF;

  -- Preserve the financial row while allowing auth deletion to erase its
  -- user linkage. All other identity fields remain immutable below.
  IF OLD.user_id IS DISTINCT FROM NEW.user_id
     AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL) THEN
    RAISE EXCEPTION 'mobile store transaction user identity is immutable';
  END IF;

  IF ROW(
    OLD.provider,
    OLD.store_transaction_id,
    OLD.external_order_id,
    OLD.purchase_intent_id,
    OLD.entitlement_type,
    OLD.resource_id,
    OLD.amount_subunits,
    OLD.currency,
    OLD.credits,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.provider,
    NEW.store_transaction_id,
    NEW.external_order_id,
    NEW.purchase_intent_id,
    NEW.entitlement_type,
    NEW.resource_id,
    NEW.amount_subunits,
    NEW.currency,
    NEW.credits,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'mobile store transaction identity is immutable';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mobile_store_transactions_protect_identity
  ON public.mobile_store_transactions;
CREATE TRIGGER mobile_store_transactions_protect_identity
BEFORE UPDATE ON public.mobile_store_transactions
FOR EACH ROW EXECUTE FUNCTION public.protect_mobile_store_transaction_identity();

REVOKE ALL ON FUNCTION public.protect_mobile_purchase_intent_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_mobile_store_transaction_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_mobile_store_product_authority() FROM PUBLIC, anon, authenticated;

-- Resource prices are free-form and the repository has no deployed native
-- resource SKUs. Seed only known credit products; non-credit tiers must be
-- registered after real consumable products exist in RevenueCat and stores.
INSERT INTO public.mobile_store_products (
  product_id,
  entitlement_type,
  amount_subunits,
  currency,
  credits,
  active
)
VALUES
  ('magicbooklet.credits.starter', 'credits', 41500, 'INR', 500, true),
  ('magicbooklet.credits.creator', 'credits', 166000, 'INR', 2000, true),
  ('magicbooklet.credits.pro', 'credits', 830000, 'INR', 10000, true)
ON CONFLICT (product_id) DO UPDATE
SET entitlement_type = EXCLUDED.entitlement_type,
    amount_subunits = EXCLUDED.amount_subunits,
    currency = EXCLUDED.currency,
    credits = EXCLUDED.credits,
    active = EXCLUDED.active,
    updated_at = timezone('utc'::text, now());

CREATE OR REPLACE FUNCTION public.provision_mobile_store_product(
  p_product_id text,
  p_entitlement_type text,
  p_amount_subunits integer,
  p_currency text DEFAULT 'USD'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.mobile_store_products%ROWTYPE;
  v_tier_product_id text;
BEGIN
  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL
     OR length(p_product_id) > 200
     OR p_product_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]+$'
     OR p_entitlement_type IS NULL
     OR p_entitlement_type NOT IN ('marketplace_unlock', 'post_resource_unlock')
     OR p_amount_subunits IS NULL
     OR p_amount_subunits < 100
     OR p_currency IS NULL
     OR p_currency <> 'USD' THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_existing
  FROM public.mobile_store_products
  WHERE product_id = p_product_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.entitlement_type = p_entitlement_type
       AND v_existing.amount_subunits = p_amount_subunits
       AND v_existing.currency = p_currency
       AND v_existing.credits IS NULL THEN
      RETURN jsonb_build_object(
        'status', 'already_configured',
        'product_id', v_existing.product_id,
        'active', v_existing.active
      );
    END IF;
    RETURN jsonb_build_object('status', 'product_conflict');
  END IF;

  SELECT product_id INTO v_tier_product_id
  FROM public.mobile_store_products
  WHERE entitlement_type = p_entitlement_type
    AND amount_subunits = p_amount_subunits
    AND currency = p_currency
    AND active = true
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'tier_already_configured',
      'product_id', v_tier_product_id
    );
  END IF;

  INSERT INTO public.mobile_store_products (
    product_id,
    entitlement_type,
    amount_subunits,
    currency,
    credits,
    active
  )
  VALUES (
    btrim(p_product_id),
    p_entitlement_type,
    p_amount_subunits,
    p_currency,
    NULL,
    true
  )
  RETURNING * INTO v_existing;

  RETURN jsonb_build_object(
    'status', 'provisioned',
    'product_id', v_existing.product_id,
    'entitlement_type', v_existing.entitlement_type,
    'amount_subunits', v_existing.amount_subunits,
    'currency', v_existing.currency,
    'active', v_existing.active
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_mobile_store_product_active(
  p_product_id text,
  p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product public.mobile_store_products%ROWTYPE;
  v_conflicting_product_id text;
BEGIN
  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL OR p_active IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_product
  FROM public.mobile_store_products
  WHERE product_id = p_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_product.entitlement_type = 'credits' THEN
    RETURN jsonb_build_object('status', 'fixed_credit_product');
  END IF;
  IF v_product.active = p_active THEN
    RETURN jsonb_build_object(
      'status', 'already_configured',
      'product_id', v_product.product_id,
      'active', v_product.active
    );
  END IF;

  IF p_active THEN
    SELECT product_id INTO v_conflicting_product_id
    FROM public.mobile_store_products
    WHERE entitlement_type = v_product.entitlement_type
      AND amount_subunits = v_product.amount_subunits
      AND currency = v_product.currency
      AND active = true
      AND product_id <> v_product.product_id
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'tier_already_configured',
        'product_id', v_conflicting_product_id
      );
    END IF;
  END IF;

  UPDATE public.mobile_store_products
  SET active = p_active
  WHERE product_id = v_product.product_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN p_active THEN 'activated' ELSE 'deactivated' END,
    'product_id', v_product.product_id,
    'active', p_active
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_mobile_store_product_provisioning_gaps()
RETURNS TABLE (
  entitlement_type text,
  amount_subunits integer,
  currency text,
  active_resource_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH active_tiers AS (
    SELECT
      'marketplace_unlock'::text AS entitlement_type,
      assets.price_usd_cents AS amount_subunits,
      'USD'::text AS currency,
      count(*)::bigint AS active_resource_count
    FROM public.marketplace_assets assets
    WHERE assets.status IN ('active', 'unlisted')
      AND assets.price_usd_cents > 0
    GROUP BY assets.price_usd_cents

    UNION ALL

    SELECT
      'post_resource_unlock'::text,
      bundles.price_usd_cents,
      'USD'::text,
      count(*)::bigint
    FROM public.post_resource_bundles bundles
    WHERE bundles.status = 'published'
      AND bundles.access_mode = 'paid'
      AND bundles.price_usd_cents > 0
    GROUP BY bundles.price_usd_cents
  )
  SELECT
    tiers.entitlement_type,
    tiers.amount_subunits,
    tiers.currency,
    tiers.active_resource_count
  FROM active_tiers tiers
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.mobile_store_products products
    WHERE products.entitlement_type = tiers.entitlement_type
      AND products.amount_subunits = tiers.amount_subunits
      AND products.currency = tiers.currency
      AND products.active = true
  )
  ORDER BY tiers.entitlement_type, tiers.amount_subunits;
$$;

REVOKE ALL ON FUNCTION public.provision_mobile_store_product(text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_mobile_store_product_active(text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_mobile_store_product_provisioning_gaps()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_mobile_store_product(text, text, integer, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_mobile_store_product_active(text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_mobile_store_product_provisioning_gaps()
  TO service_role;

COMMENT ON FUNCTION public.provision_mobile_store_product(text, text, integer, text) IS
  'Service-only catalog provisioning. Call only after the exact reusable consumable product ID and USD tier exist in RevenueCat and every enabled native store.';
COMMENT ON FUNCTION public.list_mobile_store_product_provisioning_gaps() IS
  'Deployment preflight listing active marketplace/post price tiers that cannot currently issue a server purchase intent.';

CREATE OR REPLACE FUNCTION public.bind_legacy_mobile_store_transaction_product(
  p_external_order_id text,
  p_product_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger public.mobile_store_transactions%ROWTYPE;
  v_product public.mobile_store_products%ROWTYPE;
BEGIN
  IF p_external_order_id IS NULL
     OR p_external_order_id NOT LIKE 'mobile\_%' ESCAPE '\'
     OR nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT * INTO v_ledger
  FROM public.mobile_store_transactions
  WHERE external_order_id = p_external_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_ledger.product_id NOT LIKE 'legacy.%' THEN
    RETURN jsonb_build_object(
      'status', CASE
        WHEN v_ledger.product_id = p_product_id THEN 'already_bound'
        ELSE 'identity_conflict'
      END,
      'product_id', v_ledger.product_id
    );
  END IF;

  SELECT * INTO v_product
  FROM public.mobile_store_products
  WHERE product_id = p_product_id
    AND entitlement_type = v_ledger.entitlement_type
    AND amount_subunits = v_ledger.amount_subunits
    AND currency = v_ledger.currency
    AND credits IS NOT DISTINCT FROM v_ledger.credits;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'catalog_mismatch');
  END IF;

  UPDATE public.mobile_purchase_intents
  SET product_id = v_product.product_id
  WHERE id = v_ledger.purchase_intent_id;

  UPDATE public.mobile_store_transactions
  SET product_id = v_product.product_id
  WHERE id = v_ledger.id;

  RETURN jsonb_build_object(
    'status', 'bound',
    'external_order_id', v_ledger.external_order_id,
    'product_id', v_product.product_id,
    'entitlement_type', v_ledger.entitlement_type,
    'amount_subunits', v_ledger.amount_subunits,
    'currency', v_ledger.currency
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bind_legacy_mobile_store_transaction_product(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_legacy_mobile_store_transaction_product(text, text)
  TO service_role;

COMMENT ON FUNCTION public.bind_legacy_mobile_store_transaction_product(text, text) IS
  'One-time service-only binding for backfilled orders whose old schema did not persist the RevenueCat product ID. The configured catalog SKU must exactly match entitlement type, amount, currency, and credits.';

CREATE OR REPLACE FUNCTION public.create_mobile_purchase_intent(
  p_user_id uuid,
  p_entitlement_type text,
  p_resource_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product public.mobile_store_products%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_intent public.mobile_purchase_intents%ROWTYPE;
  v_amount integer;
  v_currency text := 'USD';
BEGIN
  IF p_user_id IS NULL
     OR p_resource_id IS NULL
     OR p_entitlement_type IS NULL
     OR p_entitlement_type NOT IN ('marketplace_unlock', 'post_resource_unlock') THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  IF p_entitlement_type = 'marketplace_unlock' THEN
    SELECT * INTO v_asset
    FROM public.marketplace_assets
    WHERE id = p_resource_id;

    IF NOT FOUND OR v_asset.status NOT IN ('active', 'unlisted') THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF v_asset.seller_user_id = p_user_id THEN
      RETURN jsonb_build_object('status', 'owned_by_user');
    END IF;
    IF v_asset.price_usd_cents <= 0 THEN
      RETURN jsonb_build_object('status', 'not_paid');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.marketplace_purchases
      WHERE asset_id = v_asset.id AND buyer_user_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('status', 'already_owned');
    END IF;
    v_amount := v_asset.price_usd_cents;
  ELSE
    SELECT * INTO v_bundle
    FROM public.post_resource_bundles
    WHERE post_id = p_resource_id;

    IF NOT FOUND OR v_bundle.status <> 'published' THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
    IF v_bundle.owner_user_id = p_user_id THEN
      RETURN jsonb_build_object('status', 'owned_by_user');
    END IF;
    IF v_bundle.access_mode <> 'paid' OR v_bundle.price_usd_cents <= 0 THEN
      RETURN jsonb_build_object('status', 'not_paid');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.post_resource_bundle_purchases
      WHERE bundle_id = v_bundle.id AND buyer_user_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('status', 'already_owned');
    END IF;
    v_amount := v_bundle.price_usd_cents;
  END IF;

  SELECT * INTO v_product
  FROM public.mobile_store_products
  WHERE entitlement_type = p_entitlement_type
    AND amount_subunits = v_amount
    AND currency = v_currency
    AND active = true
  ORDER BY product_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'product_not_configured');
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
    p_entitlement_type,
    p_resource_id,
    v_product.amount_subunits,
    v_product.currency,
    NULL
  )
  RETURNING * INTO v_intent;

  RETURN jsonb_build_object(
    'status', 'created',
    'purchase_intent_id', v_intent.id,
    'product_id', v_intent.product_id,
    'entitlement_type', v_intent.entitlement_type,
    'resource_id', v_intent.resource_id,
    'amount_subunits', v_intent.amount_subunits,
    'currency', v_intent.currency,
    'expires_at', v_intent.expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_mobile_purchase_intent(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mobile_purchase_intent(uuid, text, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.complete_mobile_purchase(
  p_user_id uuid,
  p_purchase_intent_id uuid,
  p_product_id text,
  p_provider text,
  p_store_transaction_id text,
  p_external_order_id text,
  p_payment_id text
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
    status
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
    'active'
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
        mobile_product_id
      )
      VALUES (
        p_user_id,
        p_external_order_id,
        p_payment_id,
        v_amount,
        v_credits,
        'created',
        p_product_id
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

REVOKE ALL ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_mobile_purchase_adjustment(
  p_external_order_id text,
  p_user_id uuid,
  p_product_id text,
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger public.mobile_store_transactions%ROWTYPE;
  v_credit_adjustment jsonb;
  v_marketplace_order public.marketplace_orders%ROWTYPE;
  v_bundle_order public.post_resource_bundle_orders%ROWTYPE;
  v_bundle public.post_resource_bundles%ROWTYPE;
  v_purchase_id uuid;
  v_changed integer := 0;
  v_status text;
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

  SELECT * INTO v_ledger
  FROM public.mobile_store_transactions
  WHERE external_order_id = p_external_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'rewards', '[]'::jsonb);
  END IF;
  IF v_ledger.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object('status', 'identity_mismatch', 'rewards', '[]'::jsonb);
  END IF;
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
  IF v_ledger.provider_event_id = p_event_id THEN
    RETURN jsonb_build_object('status', 'duplicate_event', 'rewards', '[]'::jsonb);
  END IF;
  IF v_ledger.provider_event_timestamp_ms IS NOT NULL
     AND p_event_timestamp_ms < v_ledger.provider_event_timestamp_ms THEN
    RETURN jsonb_build_object('status', 'stale_event', 'rewards', '[]'::jsonb);
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
    IF v_credit_adjustment ->> 'status' IN (
      'not_found',
      'identity_mismatch',
      'stale_event',
      'duplicate_event',
      'invalid_request',
      'transaction_not_found',
      'provider_mismatch',
      'invalid_amount'
    ) THEN
      RETURN v_credit_adjustment;
    END IF;
    v_status := v_credit_adjustment ->> 'status';
  ELSIF v_ledger.entitlement_type = 'marketplace_unlock' THEN
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
        v_status := 'already_active';
      END IF;
    END IF;
  END IF;

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
    'rewards', coalesce(v_credit_adjustment -> 'rewards', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text)
  TO service_role;

-- Reserve historical mobile order IDs in the new global ledger. If old code
-- reused an ID across entitlement tables, the earliest authoritative record
-- wins the ledger identity and all future reuse is rejected.
DO $$
DECLARE
  v_row record;
  v_intent_id uuid;
  v_transaction_ledger_id uuid;
BEGIN
  FOR v_row IN
    SELECT *
    FROM (
      SELECT
        1 AS priority,
        t.razorpay_order_id AS external_order_id,
        t.user_id,
        coalesce(
          t.mobile_product_id,
          CASE t.credits
            WHEN 500 THEN 'magicbooklet.credits.starter'
            WHEN 2000 THEN 'magicbooklet.credits.creator'
            WHEN 10000 THEN 'magicbooklet.credits.pro'
            ELSE 'legacy.credit.' || t.id::text
          END
        ) AS product_id,
        'credits'::text AS entitlement_type,
        NULL::uuid AS resource_id,
        greatest(1, least(t.amount, 2147483647::bigint))::integer AS amount_subunits,
        'INR'::text AS currency,
        t.credits AS credits,
        t.id AS source_record_id,
        CASE WHEN t.status = 'refunded' THEN 'revoked' ELSE 'active' END AS ledger_status,
        CASE WHEN t.status = 'refunded' THEN 'revoked' ELSE 'consumed' END AS intent_status
      FROM public.transactions t
      WHERE t.razorpay_order_id LIKE 'mobile\_%' ESCAPE '\'
        AND t.status IN ('success', 'refunded')
        AND t.credits > 0

      UNION ALL

      SELECT
        2,
        o.razorpay_order_id,
        o.buyer_user_id,
        'legacy.marketplace.' || o.id::text,
        'marketplace_unlock',
        o.asset_id,
        greatest(1, o.amount_subunits),
        o.currency,
        NULL::integer,
        o.id,
        'active',
        'consumed'
      FROM public.marketplace_orders o
      WHERE o.razorpay_order_id LIKE 'mobile\_%' ESCAPE '\'
        AND o.status = 'paid'

      UNION ALL

      SELECT
        3,
        o.razorpay_order_id,
        o.buyer_user_id,
        'legacy.post-resource.' || o.id::text,
        'post_resource_unlock',
        b.post_id,
        greatest(1, o.amount_subunits),
        o.currency,
        NULL::integer,
        o.id,
        'active',
        'consumed'
      FROM public.post_resource_bundle_orders o
      JOIN public.post_resource_bundles b ON b.id = o.bundle_id
      WHERE o.razorpay_order_id LIKE 'mobile\_%' ESCAPE '\'
        AND o.status = 'paid'
    ) source
    ORDER BY external_order_id, priority
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.mobile_store_transactions
      WHERE external_order_id = v_row.external_order_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.mobile_purchase_intents (
      user_id,
      product_id,
      entitlement_type,
      resource_id,
      amount_subunits,
      currency,
      credits,
      status,
      consumed_at,
      expires_at
    )
    VALUES (
      v_row.user_id,
      v_row.product_id,
      v_row.entitlement_type,
      v_row.resource_id,
      v_row.amount_subunits,
      v_row.currency,
      v_row.credits,
      v_row.intent_status,
      timezone('utc'::text, now()),
      timezone('utc'::text, now())
    )
    RETURNING id INTO v_intent_id;

    v_transaction_ledger_id := NULL;
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
      source_record_id,
      status
    )
    VALUES (
      CASE
        WHEN v_row.external_order_id LIKE 'mobile_app_store_%' THEN 'app_store'
        WHEN v_row.external_order_id LIKE 'mobile_play_store_%' THEN 'play_store'
        WHEN v_row.external_order_id LIKE 'mobile_sandbox_%' THEN 'sandbox'
        ELSE 'revenuecat'
      END,
      CASE
        WHEN v_row.external_order_id LIKE 'mobile_app_store_%'
          THEN substring(v_row.external_order_id FROM char_length('mobile_app_store_') + 1)
        WHEN v_row.external_order_id LIKE 'mobile_play_store_%'
          THEN substring(v_row.external_order_id FROM char_length('mobile_play_store_') + 1)
        WHEN v_row.external_order_id LIKE 'mobile_sandbox_%'
          THEN substring(v_row.external_order_id FROM char_length('mobile_sandbox_') + 1)
        WHEN v_row.external_order_id LIKE 'mobile_revenuecat_%'
          THEN substring(v_row.external_order_id FROM char_length('mobile_revenuecat_') + 1)
        ELSE v_row.external_order_id
      END,
      v_row.external_order_id,
      v_row.user_id,
      v_row.product_id,
      v_intent_id,
      v_row.entitlement_type,
      v_row.resource_id,
      v_row.amount_subunits,
      v_row.currency,
      v_row.credits,
      v_row.source_record_id,
      v_row.ledger_status
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_transaction_ledger_id;

    IF v_transaction_ledger_id IS NULL THEN
      DELETE FROM public.mobile_purchase_intents WHERE id = v_intent_id;
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.mobile_store_products IS
  'Backend-owned mapping from store SKU to immutable entitlement price/currency/credit authority.';
COMMENT ON TABLE public.mobile_purchase_intents IS
  'Server-issued immutable snapshots binding a user, SKU, entitlement resource, amount, and currency.';
COMMENT ON TABLE public.mobile_store_transactions IS
  'Global mobile transaction ledger; a store transaction can be consumed by exactly one entitlement.';
COMMENT ON COLUMN public.mobile_purchase_intents.user_id IS
  'Nullable only for one-way account-deletion anonymization; the immutable intent snapshot is retained.';
COMMENT ON COLUMN public.mobile_store_transactions.user_id IS
  'Nullable only for one-way account-deletion anonymization; financial settlement evidence is retained.';

-- Marketplace-asset sales now pay sellers.
--
-- marketplace_assets.earnings_usd_cents has been accruing on every cash sale
-- with no path into creator_resource_wallets, so sellers on this rail could
-- watch earnings grow but never withdraw them (the bundle rail has paid an
-- exact 85% share into wallets since the sale-economics migration). Product
-- decision 2026-08-19: wire marketplace sales into the same wallets at the
-- same 85/15 split, and backfill what has already accrued.
--
-- The mechanism mirrors the bundle rail one-to-one:
-- - an AFTER INSERT trigger on marketplace_purchases writes an idempotent
--   creator_resource_wallet_entries row ('marketplace-purchase:<id>') and
--   accumulates the wallet under the same transaction that recorded the sale;
-- - the split is computed from the purchase row's price_usd_cents (whole
--   tokens; 100 tokens = USD 1), never from payment-provider amount_subunits,
--   which may be INR;
-- - free unlocks record price_usd_cents = 0 and credit nothing.
--
-- Refunds reverse the credit the same way the bundle rail does:
-- reconcile_marketplace_cash_adjustment deletes the purchase row and then
-- flips the order paid→failed, so a status-transition trigger reverses the
-- wallet entry only after the entitlement is really gone. The double-purchase
-- guard's paid→failed transition is naturally a no-op — no sale entry was ever
-- written for that order.
--
-- marketplace_assets.earnings_usd_cents keeps its existing gross-accrual
-- semantics; the wallet ledger, not that projection, is the money of record.

-- 1. Ledger traceability for the marketplace rail. ---------------------------

ALTER TABLE public.creator_resource_wallet_entries
  ADD COLUMN IF NOT EXISTS marketplace_asset_id uuid
    REFERENCES public.marketplace_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS creator_resource_wallet_entries_marketplace_asset_idx
  ON public.creator_resource_wallet_entries (marketplace_asset_id, id DESC)
  WHERE marketplace_asset_id IS NOT NULL;

COMMENT ON COLUMN public.creator_resource_wallet_entries.marketplace_asset_id IS
  'Set on entries from marketplace-asset sales; bundle_id stays NULL for them.';

-- 2. Sale-time crediting, mirroring apply_post_resource_wallet_purchase_change.

CREATE OR REPLACE FUNCTION public.apply_marketplace_wallet_purchase_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seller_user_id uuid;
  v_entry_id bigint;
  v_creator_subunits bigint;
  v_platform_subunits bigint;
BEGIN
  IF NEW.price_usd_cents <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT seller_user_id
  INTO v_seller_user_id
  FROM public.marketplace_assets
  WHERE id = NEW.asset_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Marketplace asset not found for creator settlement';
  END IF;

  v_creator_subunits := NEW.price_usd_cents::bigint * 85;
  v_platform_subunits := NEW.price_usd_cents::bigint * 15;

  INSERT INTO public.creator_resource_wallet_entries (
    event_key,
    user_id,
    marketplace_asset_id,
    purchase_id,
    order_id,
    entry_kind,
    gross_token_units,
    creator_amount_token_subunits,
    platform_fee_token_subunits
  ) VALUES (
    'marketplace-purchase:' || NEW.id::text,
    v_seller_user_id,
    NEW.asset_id,
    NEW.id,
    NEW.order_id,
    'sale',
    NEW.price_usd_cents,
    v_creator_subunits,
    v_platform_subunits
  )
  ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_entry_id;

  IF v_entry_id IS NOT NULL THEN
    INSERT INTO public.creator_resource_wallets (
      user_id,
      available_token_subunits,
      lifetime_earned_token_subunits
    ) VALUES (
      v_seller_user_id,
      v_creator_subunits,
      v_creator_subunits
    )
    ON CONFLICT (user_id) DO UPDATE
    SET available_token_subunits = creator_resource_wallets.available_token_subunits
          + EXCLUDED.available_token_subunits,
        lifetime_earned_token_subunits = creator_resource_wallets.lifetime_earned_token_subunits
          + EXCLUDED.lifetime_earned_token_subunits,
        updated_at = timezone('utc'::text, now());
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_marketplace_wallet_purchase_change()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS marketplace_purchase_creator_settlement
  ON public.marketplace_purchases;
CREATE TRIGGER marketplace_purchase_creator_settlement
AFTER INSERT ON public.marketplace_purchases
FOR EACH ROW
EXECUTE FUNCTION public.apply_marketplace_wallet_purchase_change();

-- 3. Refund reversal, mirroring reverse_post_resource_wallet_on_refund. ------

CREATE OR REPLACE FUNCTION public.reverse_marketplace_wallet_on_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sale public.creator_resource_wallet_entries%ROWTYPE;
  v_entry_id bigint;
BEGIN
  IF OLD.status <> 'paid' OR NEW.status <> 'failed' THEN
    RETURN NEW;
  END IF;

  -- Reverse settlement only after the authoritative refund transaction has
  -- removed the entitlement row; deletions (account/asset removal) delete
  -- orders rather than transitioning them.
  IF EXISTS (
    SELECT 1
    FROM public.marketplace_purchases
    WHERE order_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  SELECT entries.*
  INTO v_sale
  FROM public.creator_resource_wallet_entries AS entries
  WHERE entries.order_id = NEW.id
    AND entries.entry_kind = 'sale'
    AND NOT EXISTS (
      SELECT 1
      FROM public.creator_resource_wallet_entries AS refunds
      WHERE refunds.event_key = 'refund-marketplace-purchase:' || entries.purchase_id::text
    )
  ORDER BY entries.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.creator_resource_wallet_entries (
    event_key,
    user_id,
    marketplace_asset_id,
    purchase_id,
    order_id,
    entry_kind,
    gross_token_units,
    creator_amount_token_subunits,
    platform_fee_token_subunits
  ) VALUES (
    'refund-marketplace-purchase:' || v_sale.purchase_id::text,
    v_sale.user_id,
    v_sale.marketplace_asset_id,
    v_sale.purchase_id,
    NEW.id,
    'refund',
    v_sale.gross_token_units,
    -v_sale.creator_amount_token_subunits,
    -v_sale.platform_fee_token_subunits
  )
  ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_entry_id;

  IF v_entry_id IS NOT NULL THEN
    UPDATE public.creator_resource_wallets
    SET available_token_subunits = available_token_subunits
          - v_sale.creator_amount_token_subunits,
        lifetime_refunded_token_subunits = lifetime_refunded_token_subunits
          + v_sale.creator_amount_token_subunits,
        updated_at = timezone('utc'::text, now())
    WHERE user_id = v_sale.user_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_marketplace_wallet_on_refund()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS marketplace_order_creator_refund
  ON public.marketplace_orders;
CREATE TRIGGER marketplace_order_creator_refund
AFTER UPDATE OF status ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.reverse_marketplace_wallet_on_refund();

-- 4. Backfill sales that predate the trigger. --------------------------------

-- Retained purchase rows are the authoritative record. The event_key makes
-- this idempotent, and the wallet update accumulates on top of existing
-- bundle-rail balances (unlike the sale-economics migration, wallets are not
-- empty here, so an absolute SET would destroy bundle earnings).
WITH backfilled AS (
  INSERT INTO public.creator_resource_wallet_entries (
    event_key,
    user_id,
    marketplace_asset_id,
    purchase_id,
    order_id,
    entry_kind,
    gross_token_units,
    creator_amount_token_subunits,
    platform_fee_token_subunits,
    created_at
  )
  SELECT
    'marketplace-purchase:' || purchases.id::text,
    assets.seller_user_id,
    assets.id,
    purchases.id,
    purchases.order_id,
    'sale',
    purchases.price_usd_cents,
    purchases.price_usd_cents::bigint * 85,
    purchases.price_usd_cents::bigint * 15,
    purchases.created_at
  FROM public.marketplace_purchases AS purchases
  JOIN public.marketplace_assets AS assets ON assets.id = purchases.asset_id
  WHERE purchases.price_usd_cents > 0
  ON CONFLICT (event_key) DO NOTHING
  RETURNING user_id, creator_amount_token_subunits
)
INSERT INTO public.creator_resource_wallets (
  user_id,
  available_token_subunits,
  lifetime_earned_token_subunits
)
SELECT
  user_id,
  sum(creator_amount_token_subunits),
  sum(creator_amount_token_subunits)
FROM backfilled
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
SET available_token_subunits = creator_resource_wallets.available_token_subunits
      + EXCLUDED.available_token_subunits,
    lifetime_earned_token_subunits = creator_resource_wallets.lifetime_earned_token_subunits
      + EXCLUDED.lifetime_earned_token_subunits,
    updated_at = timezone('utc'::text, now());

-- Aggregate earnings with no surviving purchase row (e.g. purchases removed by
-- account deletions that predate the purchases-survive-deletion migration).
-- Credits only the positive gap, never double-counting the rows above.
WITH gaps AS (
  SELECT
    assets.id AS asset_id,
    assets.seller_user_id,
    assets.created_at,
    greatest(
      0,
      assets.earnings_usd_cents
        - coalesce(sum(purchases.price_usd_cents), 0)
    )::integer AS legacy_gross_tokens
  FROM public.marketplace_assets AS assets
  LEFT JOIN public.marketplace_purchases AS purchases
    ON purchases.asset_id = assets.id
  GROUP BY assets.id, assets.seller_user_id, assets.created_at, assets.earnings_usd_cents
),
backfilled AS (
  INSERT INTO public.creator_resource_wallet_entries (
    event_key,
    user_id,
    marketplace_asset_id,
    purchase_id,
    order_id,
    entry_kind,
    gross_token_units,
    creator_amount_token_subunits,
    platform_fee_token_subunits,
    created_at
  )
  SELECT
    'marketplace-legacy:' || asset_id::text,
    seller_user_id,
    asset_id,
    NULL,
    NULL,
    'legacy_sale',
    legacy_gross_tokens,
    legacy_gross_tokens::bigint * 85,
    legacy_gross_tokens::bigint * 15,
    created_at
  FROM gaps
  WHERE legacy_gross_tokens > 0
  ON CONFLICT (event_key) DO NOTHING
  RETURNING user_id, creator_amount_token_subunits
)
INSERT INTO public.creator_resource_wallets (
  user_id,
  available_token_subunits,
  lifetime_earned_token_subunits
)
SELECT
  user_id,
  sum(creator_amount_token_subunits),
  sum(creator_amount_token_subunits)
FROM backfilled
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
SET available_token_subunits = creator_resource_wallets.available_token_subunits
      + EXCLUDED.available_token_subunits,
    lifetime_earned_token_subunits = creator_resource_wallets.lifetime_earned_token_subunits
      + EXCLUDED.lifetime_earned_token_subunits,
    updated_at = timezone('utc'::text, now());

-- Cash settlement must use the server quote that created the provider order.
-- Historical orders deliberately remain NULL: today's listing cannot prove an
-- old checkout's price. Missing quotes keep capture retryable for operator review.
-- Free and mobile purchases settle through separate RPCs and do not need this field.
ALTER TABLE public.marketplace_orders
  ADD COLUMN quoted_price_usd_cents integer
  CHECK (quoted_price_usd_cents IS NULL OR quoted_price_usd_cents > 0);
COMMENT ON COLUMN public.marketplace_orders.quoted_price_usd_cents IS
  'Immutable USD-cent listing price quoted by the server before Razorpay order creation; required for cash fulfillment.';

CREATE OR REPLACE FUNCTION public.guard_marketplace_cash_quote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.quoted_price_usd_cents IS DISTINCT FROM OLD.quoted_price_usd_cents THEN
    RAISE EXCEPTION 'Marketplace cash quote is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_marketplace_cash_quote() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_marketplace_cash_quote
BEFORE UPDATE OF quoted_price_usd_cents ON public.marketplace_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_marketplace_cash_quote();

CREATE OR REPLACE FUNCTION public.complete_marketplace_purchase(
  p_razorpay_order_id text,
  p_razorpay_payment_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  IF nullif(btrim(p_razorpay_order_id), '') IS NULL
    OR nullif(btrim(p_razorpay_payment_id), '') IS NULL THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_order_id = btrim(p_razorpay_order_id)
  FOR UPDATE;

  IF NOT FOUND OR v_order.status <> 'created'
    OR v_order.quoted_price_usd_cents IS NULL
    OR v_order.quoted_price_usd_cents <= 0 THEN
    RETURN false;
  END IF;

  SELECT *
  INTO v_asset
  FROM public.marketplace_assets
  WHERE id = v_order.asset_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.marketplace_orders
  SET status = 'paid',
      razorpay_payment_id = btrim(p_razorpay_payment_id),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id
    AND status = 'created';

  IF NOT FOUND THEN
    RETURN false;
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
    v_order.asset_id,
    v_order.buyer_user_id,
    v_order.id,
    v_order.quoted_price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    -- A second checkout for content the buyer already owns must not leave a
    -- paid order without its own entitlement. Preserve the payment id for ops
    -- reconciliation, but make the local order terminal and non-fulfillable.
    UPDATE public.marketplace_orders
    SET status = 'failed',
        updated_at = timezone('utc'::text, now())
    WHERE id = v_order.id
      AND status = 'paid';

    RETURN false;
  END IF;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_order.quoted_price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.asset_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_marketplace_purchase(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_marketplace_purchase(text, text) TO service_role;

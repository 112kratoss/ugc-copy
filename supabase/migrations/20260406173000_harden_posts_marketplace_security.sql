DROP POLICY IF EXISTS "Post saves are viewable by everyone" ON public.post_saves;
DROP POLICY IF EXISTS "Users can view their own post saves" ON public.post_saves;
CREATE POLICY "Users can view their own post saves"
  ON public.post_saves FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Post share events are viewable by everyone" ON public.post_share_events;

CREATE OR REPLACE FUNCTION public.complete_marketplace_purchase(
  p_razorpay_order_id text,
  p_razorpay_payment_id text
)
RETURNS boolean AS $$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_asset public.marketplace_assets%ROWTYPE;
  v_purchase_id uuid;
BEGIN
  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE razorpay_order_id = p_razorpay_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_order.status = 'paid' THEN
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
      razorpay_payment_id = p_razorpay_payment_id,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.id;

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
    v_asset.price_usd_cents,
    v_order.amount_subunits,
    v_order.currency
  )
  ON CONFLICT (asset_id, buyer_user_id) DO NOTHING
  RETURNING id INTO v_purchase_id;

  IF v_purchase_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.marketplace_assets
  SET sales_count = sales_count + 1,
      earnings_usd_cents = earnings_usd_cents + v_asset.price_usd_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order.asset_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

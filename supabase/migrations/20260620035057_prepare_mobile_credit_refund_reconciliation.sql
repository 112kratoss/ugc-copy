ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS mobile_product_id text,
  ADD COLUMN IF NOT EXISTS credit_effect_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS revenuecat_event_id text,
  ADD COLUMN IF NOT EXISTS revenuecat_event_timestamp_ms bigint;

UPDATE public.transactions
SET credit_effect_applied = true
WHERE status = 'success'
  AND credit_effect_applied = false;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('created', 'success', 'failed', 'refunded'));

CREATE OR REPLACE FUNCTION public.add_credits(
  p_user_id uuid,
  p_credits integer,
  p_transaction_id uuid,
  p_payment_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  txn_status text;
  txn_credits integer;
  credits_applied boolean;
BEGIN
  SELECT status, credits, credit_effect_applied
    INTO txn_status, txn_credits, credits_applied
  FROM public.transactions
  WHERE id = p_transaction_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR txn_status = 'success' OR credits_applied THEN
    RETURN false;
  END IF;

  IF txn_status <> 'created' OR p_credits <= 0 OR p_credits <> txn_credits THEN
    RETURN false;
  END IF;

  UPDATE public.profiles
  SET credits = credits + txn_credits
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for credit transaction';
  END IF;

  UPDATE public.transactions
  SET status = 'success',
      credit_effect_applied = true,
      razorpay_payment_id = p_payment_id,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_transaction_id
    AND user_id = p_user_id
    AND status = 'created';

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_mobile_credit_refund(
  p_external_order_id text,
  p_user_id uuid,
  p_product_id text,
  p_event_id text,
  p_event_timestamp_ms bigint,
  p_action text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  txn public.transactions%ROWTYPE;
  event_time timestamptz;
BEGIN
  IF p_action NOT IN ('refund', 'restore')
    OR p_external_order_id IS NULL
    OR p_external_order_id NOT LIKE 'mobile\_%' ESCAPE '\'
    OR p_product_id IS NULL
    OR p_product_id NOT LIKE 'magicbooklet.credits.%'
    OR p_event_id IS NULL
    OR btrim(p_event_id) = ''
    OR p_event_timestamp_ms IS NULL
    OR p_event_timestamp_ms <= 0
  THEN
    RAISE EXCEPTION 'invalid mobile credit refund event';
  END IF;

  SELECT *
    INTO txn
  FROM public.transactions
  WHERE razorpay_order_id = p_external_order_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF txn.mobile_product_id IS NOT NULL
    AND txn.mobile_product_id <> p_product_id
  THEN
    RETURN 'identity_mismatch';
  END IF;

  IF txn.revenuecat_event_timestamp_ms IS NOT NULL
    AND p_event_timestamp_ms < txn.revenuecat_event_timestamp_ms
  THEN
    RETURN 'stale_event';
  END IF;

  IF txn.revenuecat_event_id = p_event_id THEN
    RETURN 'duplicate_event';
  END IF;

  event_time := to_timestamp(p_event_timestamp_ms / 1000.0);

  IF p_action = 'refund' THEN
    IF txn.status = 'refunded' THEN
      UPDATE public.transactions
      SET mobile_product_id = COALESCE(mobile_product_id, p_product_id),
          revenuecat_event_id = p_event_id,
          revenuecat_event_timestamp_ms = p_event_timestamp_ms,
          updated_at = timezone('utc'::text, now())
      WHERE id = txn.id;
      RETURN 'already_refunded';
    END IF;

    IF txn.status NOT IN ('created', 'success') THEN
      RETURN 'not_credited';
    END IF;

    IF txn.credit_effect_applied THEN
      UPDATE public.profiles
      SET credits = credits - txn.credits
      WHERE id = txn.user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'profile not found for mobile refund';
      END IF;
    END IF;

    UPDATE public.transactions
    SET status = 'refunded',
        credit_effect_applied = false,
        mobile_product_id = COALESCE(mobile_product_id, p_product_id),
        refunded_at = event_time,
        revenuecat_event_id = p_event_id,
        revenuecat_event_timestamp_ms = p_event_timestamp_ms,
        updated_at = timezone('utc'::text, now())
    WHERE id = txn.id;

    RETURN 'refunded';
  END IF;

  IF txn.status = 'success' AND txn.credit_effect_applied THEN
    UPDATE public.transactions
    SET mobile_product_id = COALESCE(mobile_product_id, p_product_id),
        revenuecat_event_id = p_event_id,
        revenuecat_event_timestamp_ms = p_event_timestamp_ms,
        updated_at = timezone('utc'::text, now())
    WHERE id = txn.id;
    RETURN 'already_active';
  END IF;

  IF txn.status <> 'refunded' THEN
    RETURN 'not_refunded';
  END IF;

  UPDATE public.profiles
  SET credits = credits + txn.credits
  WHERE id = txn.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for reversed mobile refund';
  END IF;

  UPDATE public.transactions
  SET status = 'success',
      credit_effect_applied = true,
      mobile_product_id = COALESCE(mobile_product_id, p_product_id),
      refunded_at = NULL,
      revenuecat_event_id = p_event_id,
      revenuecat_event_timestamp_ms = p_event_timestamp_ms,
      updated_at = timezone('utc'::text, now())
  WHERE id = txn.id;

  RETURN 'restored';
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) TO service_role;

-- The Razorpay grant must preserve payment provenance even if a trusted caller
-- passes incomplete evidence. RevenueCat uses its separate mobile settlement.
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
  txn public.transactions%ROWTYPE;
  payment_id text := nullif(btrim(p_payment_id), '');
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR payment_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO txn
  FROM public.transactions
  WHERE id = p_transaction_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
     OR txn.status <> 'created'
     OR txn.credit_effect_applied
     OR p_credits <> txn.credits
     OR txn.mobile_product_id IS NOT NULL
     OR (txn.razorpay_payment_id IS NOT NULL
         AND txn.razorpay_payment_id <> payment_id) THEN
    RETURN false;
  END IF;

  UPDATE public.profiles
  SET credits = credits + txn.credits
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for credit transaction';
  END IF;

  -- The unique payment index rejects cross-transaction reuse. Any resulting
  -- exception also rolls back the balance update above.
  UPDATE public.transactions
  SET status = 'success',
      credit_effect_applied = true,
      razorpay_payment_id = payment_id,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_transaction_id
    AND user_id = p_user_id
    AND status = 'created';

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_credits(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer, uuid, text) TO service_role;

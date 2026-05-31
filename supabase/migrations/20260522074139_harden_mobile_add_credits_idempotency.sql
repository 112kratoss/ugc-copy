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
BEGIN
  SELECT status
    INTO txn_status
  FROM public.transactions
  WHERE id = p_transaction_id
    AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR txn_status = 'success' THEN
    RETURN false;
  END IF;

  IF txn_status = 'created' THEN
    UPDATE public.transactions
    SET status = 'success',
        razorpay_payment_id = p_payment_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_transaction_id
      AND user_id = p_user_id
      AND status = 'created';

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    UPDATE public.profiles
    SET credits = credits + p_credits
    WHERE id = p_user_id;

    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

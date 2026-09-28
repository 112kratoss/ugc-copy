-- Repair the mobile caller left incompatible by the Razorpay grant hardening.
-- Replace only its grant block; preserve all catalog, intent and store-identity
-- checks in the existing function, including any prior migration changes.
DO $migration$
DECLARE
  definition text;
  old_grant text := $old$      IF NOT public.add_credits(
        p_user_id,
        v_credits,
        v_credit_transaction.id,
        p_payment_id
      ) THEN
        RAISE EXCEPTION 'mobile credit settlement failed';
      END IF;$old$;
  new_grant text := $new$      -- This function has already bound the verified store transaction to its
      -- server-owned product/intent and inserted the unique mobile ledger row.
      -- add_credits is the Razorpay-only boundary; grant here atomically with
      -- that mobile ledger instead of routing through the other payment rail.
      IF v_credit_transaction.credit_effect_applied
         OR (v_credit_transaction.razorpay_payment_id IS NOT NULL
             AND v_credit_transaction.razorpay_payment_id <> p_payment_id) THEN
        RAISE EXCEPTION 'mobile credit transaction grant conflict';
      END IF;

      UPDATE public.profiles
      SET credits = credits + v_credits
      WHERE id = p_user_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'profile not found for mobile credit transaction';
      END IF;

      UPDATE public.transactions
      SET status = 'success',
          credit_effect_applied = true,
          razorpay_payment_id = p_payment_id,
          updated_at = timezone('utc'::text, now())
      WHERE id = v_credit_transaction.id
        AND status = 'created'
        AND NOT credit_effect_applied;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'mobile credit transaction grant conflict';
      END IF;$new$;
BEGIN
  SELECT pg_get_functiondef('public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_grant, ''))) / length(old_grant) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one mobile add_credits grant block';
  END IF;
  EXECUTE replace(definition, old_grant, new_grant);
END;
$migration$;

REVOKE ALL ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_mobile_purchase(uuid, uuid, text, text, text, text, text, numeric, text) TO service_role;

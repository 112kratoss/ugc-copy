-- Add refunded flag to generations to prevent double-refunds
ALTER TABLE public.generations ADD COLUMN IF NOT EXISTS refunded boolean DEFAULT false;

-- Create refund_credits RPC
CREATE OR REPLACE FUNCTION public.refund_credits(p_user_id uuid, p_amount integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE profiles SET credits = credits + p_amount WHERE id = p_user_id;
END;
$$;

-- Refund credits for a failed generation (idempotent — checks refunded flag)
CREATE OR REPLACE FUNCTION public.refund_generation(p_prediction_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  gen RECORD;
BEGIN
  SELECT user_id, cost, refunded INTO gen
  FROM generations
  WHERE prediction_id = p_prediction_id;

  IF NOT FOUND OR gen.refunded = true OR gen.cost IS NULL THEN
    RETURN false;
  END IF;

  UPDATE profiles SET credits = credits + gen.cost WHERE id = gen.user_id;
  UPDATE generations SET refunded = true WHERE prediction_id = p_prediction_id;

  RETURN true;
END;
$$;

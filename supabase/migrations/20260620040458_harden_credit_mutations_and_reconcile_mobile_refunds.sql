REVOKE ALL ON FUNCTION public.add_credits(uuid, integer, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.add_credits(uuid, integer, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_credits(uuid, integer, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.deduct_credits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deduct_credits(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.deduct_credits(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_credits(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.refund_credits(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_credits(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.refund_credits(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_credits(uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.refund_generation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_generation(text) FROM anon;
REVOKE ALL ON FUNCTION public.refund_generation(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_generation(text) TO service_role;

REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refund_ai_usage_event(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_usage_event(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_mobile_credit_refund(text, uuid, text, text, bigint, text) TO service_role;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.transactions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.transactions FROM authenticated;

DROP POLICY IF EXISTS "Users can insert their own transactions." ON public.transactions;
DROP POLICY IF EXISTS "Users can update their own transactions." ON public.transactions;
DROP POLICY IF EXISTS "Users can view their own transactions." ON public.transactions;
CREATE POLICY "Users can view their own transactions."
  ON public.transactions
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.profiles FROM anon;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE ON TABLE public.profiles FROM anon;
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
GRANT UPDATE (username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location) ON TABLE public.profiles TO authenticated;

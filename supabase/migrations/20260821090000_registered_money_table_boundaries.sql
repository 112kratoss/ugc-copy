-- Financial and paid-marketplace routes require a registered account, but a
-- Supabase anonymous session also assumes the `authenticated` database role.
-- Keep the existing owner policies and add a restrictive identity gate so a
-- guest cannot read financial rows even if historical/service-side data exists
-- for that guest identity.

CREATE OR REPLACE FUNCTION public.current_identity_is_registered()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT NOT COALESCE(users.is_anonymous, false)
      FROM auth.users AS users
      WHERE users.id = (SELECT auth.uid())
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.current_identity_is_registered()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_is_registered()
  TO authenticated, service_role;

DROP POLICY IF EXISTS registered_identity_only ON public.transactions;
CREATE POLICY registered_identity_only
  ON public.transactions
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

DROP POLICY IF EXISTS registered_identity_only ON public.creator_resource_wallets;
CREATE POLICY registered_identity_only
  ON public.creator_resource_wallets
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

DROP POLICY IF EXISTS registered_identity_only ON public.creator_resource_wallet_entries;
CREATE POLICY registered_identity_only
  ON public.creator_resource_wallet_entries
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

DROP POLICY IF EXISTS registered_identity_only ON public.creator_payout_requests;
CREATE POLICY registered_identity_only
  ON public.creator_payout_requests
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

DROP POLICY IF EXISTS registered_identity_only ON public.marketplace_orders;
CREATE POLICY registered_identity_only
  ON public.marketplace_orders
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

DROP POLICY IF EXISTS registered_identity_only ON public.marketplace_purchases;
CREATE POLICY registered_identity_only
  ON public.marketplace_purchases
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_registered()))
  WITH CHECK ((SELECT public.current_identity_is_registered()));

COMMENT ON FUNCTION public.current_identity_is_registered() IS
  'RLS identity gate for registered-only financial data; auth.users is authoritative instead of client-writable profile data.';

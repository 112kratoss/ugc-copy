-- Operator amounts must not be truncated by a per-request Data API row cap.
CREATE FUNCTION public.admin_creator_wallet_totals()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'wallet_count', count(*),
    'available_token_subunits', coalesce(sum(w.available_token_subunits), 0),
    'lifetime_earned_token_subunits', coalesce(sum(w.lifetime_earned_token_subunits), 0)
  )
  FROM public.creator_resource_wallets w;
$$;

REVOKE ALL ON FUNCTION public.admin_creator_wallet_totals() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_creator_wallet_totals() TO service_role;

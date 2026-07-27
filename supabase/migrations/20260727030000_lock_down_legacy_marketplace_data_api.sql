-- marketplace_assets is a server-layer resource. Its original migration
-- granted clients whole-row SELECT access for active and unlisted listings,
-- which also exposed private seller counters. Keep all reads and writes behind
-- the authenticated API services.
REVOKE ALL PRIVILEGES ON TABLE public.marketplace_assets
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_column_list text;
BEGIN
  SELECT string_agg(
    quote_ident(columns.column_name),
    ', ' ORDER BY columns.ordinal_position
  )
  INTO v_column_list
  FROM information_schema.columns
  WHERE columns.table_schema = 'public'
    AND columns.table_name = 'marketplace_assets';

  IF v_column_list IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.marketplace_assets FROM PUBLIC, anon, authenticated, service_role',
      v_column_list
    );
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Sellers can view their own assets"
  ON public.marketplace_assets;
DROP POLICY IF EXISTS "Sellers can insert their own assets"
  ON public.marketplace_assets;
DROP POLICY IF EXISTS "Sellers can update their own assets"
  ON public.marketplace_assets;
DROP POLICY IF EXISTS "Sellers can delete their own assets"
  ON public.marketplace_assets;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_assets
  TO service_role;

-- posts is also service-layer managed. These policies were inert after client
-- table grants were revoked, but retaining them could silently reopen writes
-- if a later migration accidentally restored a grant.
DROP POLICY IF EXISTS "Users can insert their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts;

-- Post resource bundles are a backend-owned contract, exactly like posts and
-- post_media became in 20260726071722. Until now the bundle tables kept their
-- default client grants plus owner INSERT/UPDATE/DELETE policies, so an
-- authenticated creator could write the row directly through PostgREST and
-- bypass apply_post_resource_bundle_mutation -- the function that runs the
-- marketplace quality gate, normalizes resource items, and enforces the
-- owner/visibility/price invariants. That path also let a creator set
-- sales_count, gross_sales_tokens and the creator/platform earning columns by
-- hand. The wallet itself is trigger-driven so money was never writable, but
-- the display counters were, and the inconsistency is the kind that becomes a
-- real hole the moment someone adds a policy.
--
-- Orders and purchases keep their buyer SELECT policies as defense in depth,
-- but lose the default write grants: an entitlement row must only ever be born
-- inside complete_post_resource_bundle_purchase.

REVOKE ALL PRIVILEGES ON TABLE
  public.post_resource_bundles,
  public.post_resource_bundle_orders,
  public.post_resource_bundle_purchases
FROM PUBLIC, anon, authenticated, service_role;

-- Table-scope REVOKE leaves separately granted column privileges in place.
DO $$
DECLARE
  v_table_name text;
  v_column_list text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'post_resource_bundles',
    'post_resource_bundle_orders',
    'post_resource_bundle_purchases'
  ]
  LOOP
    SELECT string_agg(quote_ident(columns.column_name), ', ' ORDER BY columns.ordinal_position)
    INTO v_column_list
    FROM information_schema.columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = v_table_name;

    IF v_column_list IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
        v_column_list,
        v_table_name
      );
    END IF;
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.post_resource_bundles,
  public.post_resource_bundle_orders,
  public.post_resource_bundle_purchases
TO service_role;

-- Writes now have exactly one door: the service-role RPCs.
DROP POLICY IF EXISTS "Users can insert their own post resource bundles"
  ON public.post_resource_bundles;
DROP POLICY IF EXISTS "Users can update their own post resource bundles"
  ON public.post_resource_bundles;
DROP POLICY IF EXISTS "Users can delete their own post resource bundles"
  ON public.post_resource_bundles;

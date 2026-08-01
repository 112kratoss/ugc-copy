-- Three loose ends in the post system, none load-bearing on their own, each of
-- them the kind of inconsistency that misleads the next reader.

-- 1. posts_public_surface_check still enumerated the 'motion' and 'ugc-ad'
--    categories that posts_category_check dropped in 20260619133531, when those
--    rows were migrated to category='video' + creation_mode='motion'. The two
--    constraints have disagreed about the legal vocabulary ever since. Nothing
--    could violate the stale one -- category_check is strictly narrower -- but a
--    reader checking "what categories can a media post have?" got two answers.
ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_public_surface_check;

ALTER TABLE public.posts
  ADD CONSTRAINT posts_public_surface_check
    CHECK (
      (post_format = 'text' AND body IS NOT NULL AND btrim(body) <> '')
      OR (
        post_format = 'media'
        AND category IN ('image', 'video')
        AND (showcase_asset_path IS NOT NULL OR output_url IS NOT NULL)
      )
      OR (
        post_format = 'mixed'
        AND category IN ('image', 'video')
        AND body IS NOT NULL
        AND btrim(body) <> ''
        AND (showcase_asset_path IS NOT NULL OR output_url IS NOT NULL)
      )
    );

-- 2. Free unlocks mint a synthetic order per attempt. A client retry storm that
--    races past the existing-purchase check leaves 'created' rows that will
--    never settle, and they are indistinguishable from a genuinely abandoned
--    cash checkout. Sweep the stale ones; a free unlock that has not completed
--    within a day never will.
DELETE FROM public.post_resource_bundle_orders
WHERE status = 'created'
  AND amount_subunits = 0
  AND razorpay_order_id LIKE 'free_bundle_%'
  AND created_at < timezone('utc'::text, now()) - interval '1 day'
  AND NOT EXISTS (
    SELECT 1
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.order_id = post_resource_bundle_orders.id
  );

CREATE OR REPLACE FUNCTION public.prune_abandoned_free_unlock_orders(
  p_older_than interval DEFAULT interval '1 day'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.post_resource_bundle_orders
  WHERE status = 'created'
    AND amount_subunits = 0
    AND razorpay_order_id LIKE 'free_bundle_%'
    AND created_at < timezone('utc'::text, now()) - p_older_than
    AND NOT EXISTS (
      SELECT 1
      FROM public.post_resource_bundle_purchases AS purchases
      WHERE purchases.order_id = post_resource_bundle_orders.id
    );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_abandoned_free_unlock_orders(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_abandoned_free_unlock_orders(interval)
  TO service_role;

-- 3. Storage retention for purchased revisions.
--
--    An orphan sweep over post_resource_files must never delete an object that
--    a purchased revision still references, or a buyer's snapshot becomes a
--    menu with no kitchen. This projection is the authoritative "still needed"
--    set: every storage path mentioned by any revision that at least one
--    purchase points at, plus every path on a live bundle.
CREATE OR REPLACE FUNCTION public.list_referenced_post_resource_storage_paths()
RETURNS TABLE(storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH revision_paths AS (
    SELECT jsonb_array_elements(
             coalesce(revisions.resource_items, '[]'::jsonb)
             || coalesce(revisions.attachments, '[]'::jsonb)
           )->>'storagePath' AS path
    FROM public.post_resource_bundle_revisions AS revisions
    WHERE EXISTS (
      SELECT 1
      FROM public.post_resource_bundle_purchases AS purchases
      WHERE purchases.revision_id = revisions.id
    )
  ),
  live_paths AS (
    SELECT jsonb_array_elements(
             coalesce(bundles.resource_items, '[]'::jsonb)
             || coalesce(bundles.attachments, '[]'::jsonb)
           )->>'storagePath' AS path
    FROM public.post_resource_bundles AS bundles
  )
  SELECT DISTINCT path
  FROM (
    SELECT path FROM revision_paths
    UNION ALL
    SELECT path FROM live_paths
  ) AS combined
  WHERE path IS NOT NULL AND btrim(path) <> '';
$$;

REVOKE ALL ON FUNCTION public.list_referenced_post_resource_storage_paths()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_referenced_post_resource_storage_paths()
  TO service_role;

-- 4. post_share_events was left out of the retention policy, so an append-only
--    telemetry table grows without bound. Ninety days matches the other event
--    tables in 20260725120000.
CREATE OR REPLACE FUNCTION public.prune_post_share_events(
  p_older_than interval DEFAULT interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.post_share_events
  WHERE created_at < timezone('utc'::text, now()) - p_older_than;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_post_share_events(interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_post_share_events(interval)
  TO service_role;

-- The buyer's side of the marketplace: everything this user has unlocked, free
-- or paid, including unlocks whose post has since been delisted or tombstoned.
--
-- One projection rather than a join in the client, because posts, bundles and
-- purchases are all service-role-only tables and the alternative is three
-- round-trips per page. Buyer-scoped by construction: without the caller's own
-- id it returns nothing, so it cannot be used to browse someone else's library.
CREATE OR REPLACE FUNCTION public.list_viewer_post_resource_unlocks(
  p_buyer_user_id uuid,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  bundle_id uuid,
  post_id uuid,
  bundle_title text,
  preview_text text,
  access_mode text,
  price_usd_cents integer,
  purchased_at timestamptz,
  purchase_price_usd_cents integer,
  purchased_revision_number integer,
  has_newer_revision boolean,
  bundle_retired boolean,
  post_title text,
  post_body text,
  post_category text,
  post_format text,
  post_showcase_asset_path text,
  post_output_url text,
  post_tombstoned boolean,
  post_visibility text,
  owner_user_id uuid,
  owner_username text,
  owner_display_name text,
  owner_avatar_url text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH owned AS (
    SELECT
      purchases.bundle_id,
      purchases.created_at AS purchased_at,
      purchases.price_usd_cents AS purchase_price_usd_cents,
      purchases.revision_id
    FROM public.post_resource_bundle_purchases AS purchases
    WHERE purchases.buyer_user_id = p_buyer_user_id
  )
  SELECT
    bundles.id,
    bundles.post_id,
    bundles.title,
    bundles.preview_text,
    bundles.access_mode,
    bundles.price_usd_cents,
    owned.purchased_at,
    owned.purchase_price_usd_cents,
    revisions.revision_number,
    -- The creator has published a newer version since this purchase.
    coalesce(
      revisions.revision_number < (
        SELECT max(latest.revision_number)
        FROM public.post_resource_bundle_revisions AS latest
        WHERE latest.bundle_id = bundles.id
      ),
      false
    ) AS has_newer_revision,
    bundles.retired_at IS NOT NULL AS bundle_retired,
    posts.title,
    posts.body,
    posts.category,
    posts.post_format,
    posts.showcase_asset_path,
    posts.output_url,
    posts.tombstoned_at IS NOT NULL AS post_tombstoned,
    posts.visibility,
    profiles.id,
    profiles.username,
    profiles.display_name,
    profiles.avatar_url,
    count(*) OVER () AS total_count
  FROM owned
  JOIN public.post_resource_bundles AS bundles
    ON bundles.id = owned.bundle_id
  LEFT JOIN public.post_resource_bundle_revisions AS revisions
    ON revisions.id = owned.revision_id
  LEFT JOIN public.posts AS posts
    ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles
    ON profiles.id = bundles.owner_user_id
  -- A moderation take-down retracts the unlock for everyone, buyers included.
  WHERE posts.id IS NULL OR posts.review_status = 'visible'
  ORDER BY owned.purchased_at DESC, bundles.id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 24), 48))
  OFFSET greatest(0, coalesce(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_viewer_post_resource_unlocks(uuid, integer, integer)
  TO service_role;

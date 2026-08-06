-- Resource scopes point at stable post_media.media_key values. A purchase can
-- outlive its bundle, post and creator, so preserve the proof-output identity
-- at checkout instead of trying to reconstruct it from rows that may later be
-- deleted. The snapshot is presentation metadata only; resource entitlement
-- remains pinned to post_resource_bundle_revisions.

CREATE TABLE IF NOT EXISTS public.post_resource_purchase_media (
  purchase_id uuid NOT NULL
    REFERENCES public.post_resource_bundle_purchases(id) ON DELETE CASCADE,
  source_media_id uuid,
  media_key text NOT NULL,
  storage_path text,
  external_url text,
  preview_storage_path text,
  rendition_storage_path text,
  preview_thumbhash text,
  media_kind text NOT NULL CHECK (media_kind IN ('image', 'video')),
  content_type text,
  original_name text,
  width integer,
  height integer,
  duration_seconds numeric,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (purchase_id, media_key),
  UNIQUE (purchase_id, sort_order),
  CHECK (length(media_key) BETWEEN 1 AND 80),
  CHECK (sort_order >= 0 AND sort_order < 5)
);

CREATE INDEX IF NOT EXISTS post_resource_purchase_media_purchase_order_idx
  ON public.post_resource_purchase_media (purchase_id, sort_order);

ALTER TABLE public.post_resource_purchase_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "No client access to post_resource_purchase_media"
  ON public.post_resource_purchase_media;
CREATE POLICY "No client access to post_resource_purchase_media"
  ON public.post_resource_purchase_media
  FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

REVOKE ALL PRIVILEGES ON TABLE public.post_resource_purchase_media
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_resource_purchase_media TO service_role;

CREATE OR REPLACE FUNCTION public.capture_post_resource_purchase_media()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quoted_media jsonb;
BEGIN
  SELECT orders.quoted_media
  INTO v_quoted_media
  FROM public.post_resource_bundle_orders AS orders
  WHERE orders.id = NEW.order_id;

  -- Cash and free orders snapshot proof identity while holding the bundle lock.
  -- Prefer that quote over live post_media: the seller may have published a new
  -- revision or removed an old scoped output before payment completion.
  IF v_quoted_media IS NOT NULL THEN
    INSERT INTO public.post_resource_purchase_media (
      purchase_id,
      source_media_id,
      media_key,
      storage_path,
      external_url,
      preview_storage_path,
      rendition_storage_path,
      preview_thumbhash,
      media_kind,
      content_type,
      original_name,
      width,
      height,
      duration_seconds,
      sort_order
    )
    SELECT
      NEW.id,
      nullif(item->>'source_media_id', '')::uuid,
      item->>'media_key',
      nullif(item->>'storage_path', ''),
      nullif(item->>'external_url', ''),
      nullif(item->>'preview_storage_path', ''),
      nullif(item->>'rendition_storage_path', ''),
      nullif(item->>'preview_thumbhash', ''),
      item->>'media_kind',
      nullif(item->>'content_type', ''),
      nullif(item->>'original_name', ''),
      nullif(item->>'width', '')::integer,
      nullif(item->>'height', '')::integer,
      nullif(item->>'duration_seconds', '')::numeric,
      (item->>'sort_order')::integer
    FROM jsonb_array_elements(v_quoted_media) AS quoted(item)
    ORDER BY (item->>'sort_order')::integer
    ON CONFLICT DO NOTHING;

    RETURN NEW;
  END IF;

  INSERT INTO public.post_resource_purchase_media (
    purchase_id,
    source_media_id,
    media_key,
    storage_path,
    external_url,
    preview_storage_path,
    rendition_storage_path,
    preview_thumbhash,
    media_kind,
    content_type,
    original_name,
    width,
    height,
    duration_seconds,
    sort_order
  )
  SELECT
    NEW.id,
    media.id,
    media.media_key,
    media.storage_path,
    media.external_url,
    media.preview_storage_path,
    media.rendition_storage_path,
    media.preview_thumbhash,
    media.media_kind,
    media.content_type,
    media.original_name,
    media.width,
    media.height,
    media.duration_seconds,
    media.sort_order
  FROM public.post_resource_bundles AS bundles
  JOIN public.post_media AS media ON media.post_id = bundles.post_id
  WHERE bundles.id = NEW.bundle_id
  ORDER BY media.sort_order
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_post_resource_purchase_media()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS post_resource_bundle_purchases_capture_media
  ON public.post_resource_bundle_purchases;
CREATE TRIGGER post_resource_bundle_purchases_capture_media
AFTER INSERT ON public.post_resource_bundle_purchases
FOR EACH ROW
EXECUTE FUNCTION public.capture_post_resource_purchase_media();

-- A quoted order is authoritative even if its purchase landed in the narrow
-- deployment window before this trigger existed. Backfill those exact snapshots
-- first, including the deliberate empty-array case.
INSERT INTO public.post_resource_purchase_media (
  purchase_id,
  source_media_id,
  media_key,
  storage_path,
  external_url,
  preview_storage_path,
  rendition_storage_path,
  preview_thumbhash,
  media_kind,
  content_type,
  original_name,
  width,
  height,
  duration_seconds,
  sort_order
)
SELECT
  purchases.id,
  nullif(item->>'source_media_id', '')::uuid,
  item->>'media_key',
  nullif(item->>'storage_path', ''),
  nullif(item->>'external_url', ''),
  nullif(item->>'preview_storage_path', ''),
  nullif(item->>'rendition_storage_path', ''),
  nullif(item->>'preview_thumbhash', ''),
  item->>'media_kind',
  nullif(item->>'content_type', ''),
  nullif(item->>'original_name', ''),
  nullif(item->>'width', '')::integer,
  nullif(item->>'height', '')::integer,
  nullif(item->>'duration_seconds', '')::numeric,
  (item->>'sort_order')::integer
FROM public.post_resource_bundle_purchases AS purchases
JOIN public.post_resource_bundle_orders AS orders ON orders.id = purchases.order_id
CROSS JOIN LATERAL jsonb_array_elements(orders.quoted_media) AS quoted(item)
WHERE orders.quoted_media IS NOT NULL
ON CONFLICT DO NOTHING;

-- Best-effort rollout fallback for legacy purchases whose orders predate quote
-- snapshots. These rows describe the outputs that still exist at migration time.
INSERT INTO public.post_resource_purchase_media (
  purchase_id,
  source_media_id,
  media_key,
  storage_path,
  external_url,
  preview_storage_path,
  rendition_storage_path,
  preview_thumbhash,
  media_kind,
  content_type,
  original_name,
  width,
  height,
  duration_seconds,
  sort_order
)
SELECT
  purchases.id,
  media.id,
  media.media_key,
  media.storage_path,
  media.external_url,
  media.preview_storage_path,
  media.rendition_storage_path,
  media.preview_thumbhash,
  media.media_kind,
  media.content_type,
  media.original_name,
  media.width,
  media.height,
  media.duration_seconds,
  media.sort_order
FROM public.post_resource_bundle_purchases AS purchases
LEFT JOIN public.post_resource_bundle_orders AS orders ON orders.id = purchases.order_id
JOIN public.post_resource_bundles AS bundles ON bundles.id = purchases.bundle_id
JOIN public.post_media AS media ON media.post_id = bundles.post_id
WHERE orders.quoted_media IS NULL
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.post_resource_purchase_media IS
  'Immutable proof-output identity captured at purchase so scoped resources remain navigable after post or creator deletion.';

-- Showcase feed renditions.
--
-- The feed autoplays post video on scroll, and provider output arrives heavily
-- over-encoded for its resolution, so Storage egress is the first ceiling the
-- product hits. These columns track a small faststart copy that the feed
-- streams instead of the source object. The source is never replaced: the full
-- viewer, downloads, and remixes keep reading storage_path.

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS rendition_storage_path text,
  ADD COLUMN IF NOT EXISTS rendition_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS rendition_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rendition_error text,
  ADD COLUMN IF NOT EXISTS rendition_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rendition_bytes bigint;

-- Same traversal guard the preview path carries.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_rendition_storage_path_safe_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_rendition_storage_path_safe_check CHECK (
    rendition_storage_path IS NULL
    OR (
      rendition_storage_path NOT LIKE '%..%'
      AND rendition_storage_path !~ '[\\]'
      AND rendition_storage_path !~ '^/'
    )
  );

ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_rendition_status_check;

-- 'skipped' is terminal and distinct from 'failed': it means a rendition was
-- correctly declined (not a video, oversized, or no smaller than the source),
-- so the repair sweep must not keep retrying it.
ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_rendition_status_check CHECK (
    rendition_status IN ('pending', 'processing', 'ready', 'failed', 'skipped')
  );

ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_rendition_ready_requires_path_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_rendition_ready_requires_path_check CHECK (
    rendition_status <> 'ready' OR rendition_storage_path IS NOT NULL
  );

-- Existing non-video rows can never earn a rendition. Record that terminally
-- rather than leaving them 'pending' and permanently visible to the sweep.
UPDATE public.post_media
SET rendition_status = 'skipped'
WHERE media_kind <> 'video'
  AND rendition_status = 'pending';

-- Drives the repair sweep: only unresolved video rows, newest work bounded by
-- the attempt ceiling.
CREATE INDEX IF NOT EXISTS post_media_rendition_pending_idx
  ON public.post_media (created_at)
  WHERE media_kind = 'video'
    AND rendition_status IN ('pending', 'processing', 'failed');

CREATE OR REPLACE FUNCTION public.replace_post_media(
  p_post_id uuid,
  p_owner_user_id uuid,
  p_media_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_item_count integer;
  v_cover jsonb;
  v_sort_order integer;
  v_media_key text;
  v_seen_media_keys text[] := ARRAY[]::text[];
  v_existing_media_keys jsonb := '{}'::jsonb;
  v_normalized_media_items jsonb := '[]'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.posts
    WHERE id = p_post_id AND user_id = p_owner_user_id AND generation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Manual post not found or media is not editable.';
  END IF;

  IF jsonb_typeof(coalesce(p_media_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Post media must be an array.';
  END IF;

  v_item_count := jsonb_array_length(coalesce(p_media_items, '[]'::jsonb));
  IF v_item_count > 5 THEN
    RAISE EXCEPTION 'Posts support up to 5 media items.';
  END IF;

  -- Old clients do not send mediaKey. Keep the key already occupying that sort
  -- position when possible, then fall back to the deterministic legacy key.
  SELECT coalesce(jsonb_object_agg(sort_order::text, media_key), '{}'::jsonb)
  INTO v_existing_media_keys
  FROM public.post_media
  WHERE post_id = p_post_id;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(coalesce(p_media_items, '[]'::jsonb))
  LOOP
    v_sort_order := (v_item->>'sortOrder')::integer;
    v_media_key := coalesce(
      nullif(btrim(coalesce(v_item->>'mediaKey', '')), ''),
      nullif(v_existing_media_keys->>v_sort_order::text, ''),
      'media-' || (v_sort_order + 1)::text
    );

    IF length(v_media_key) > 80
      OR v_media_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' THEN
      RAISE EXCEPTION 'Post media keys may only use letters, numbers, hyphens, and underscores.';
    END IF;

    IF v_media_key = ANY(v_seen_media_keys) THEN
      RAISE EXCEPTION 'Post media keys must be unique within a post.';
    END IF;

    v_seen_media_keys := array_append(v_seen_media_keys, v_media_key);
    v_normalized_media_items := v_normalized_media_items
      || jsonb_build_array(v_item || jsonb_build_object('mediaKey', v_media_key));
  END LOOP;

  DELETE FROM public.post_media WHERE post_id = p_post_id;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(v_normalized_media_items)
  LOOP
    INSERT INTO public.post_media (
      post_id, media_key, storage_path, preview_storage_path, preview_thumbhash, preview_status,
      preview_attempt_count, preview_error, preview_generated_at, external_url,
      media_kind, content_type, original_name, width, height, duration_seconds, sort_order,
      rendition_storage_path, rendition_status, rendition_attempt_count,
      rendition_error, rendition_generated_at, rendition_bytes
    ) VALUES (
      p_post_id,
      v_item->>'mediaKey',
      nullif(btrim(coalesce(v_item->>'storagePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'previewStoragePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'previewThumbhash', '')), ''),
      coalesce(nullif(v_item->>'previewStatus', ''), 'pending'),
      coalesce((v_item->>'previewAttemptCount')::integer, 0),
      nullif(btrim(coalesce(v_item->>'previewError', '')), ''),
      CASE WHEN nullif(v_item->>'previewGeneratedAt', '') IS NULL THEN NULL ELSE (v_item->>'previewGeneratedAt')::timestamptz END,
      nullif(btrim(coalesce(v_item->>'externalUrl', '')), ''),
      v_item->>'mediaKind',
      nullif(btrim(coalesce(v_item->>'contentType', '')), ''),
      nullif(btrim(coalesce(v_item->>'originalName', '')), ''),
      CASE WHEN v_item ? 'width' THEN (v_item->>'width')::integer ELSE NULL END,
      CASE WHEN v_item ? 'height' THEN (v_item->>'height')::integer ELSE NULL END,
      CASE WHEN v_item ? 'durationSeconds' THEN (v_item->>'durationSeconds')::numeric ELSE NULL END,
      (v_item->>'sortOrder')::integer,
      nullif(btrim(coalesce(v_item->>'renditionStoragePath', '')), ''),
      coalesce(
        nullif(v_item->>'renditionStatus', ''),
        CASE WHEN v_item->>'mediaKind' = 'video' THEN 'pending' ELSE 'skipped' END
      ),
      coalesce((v_item->>'renditionAttemptCount')::integer, 0),
      nullif(btrim(coalesce(v_item->>'renditionError', '')), ''),
      CASE WHEN nullif(v_item->>'renditionGeneratedAt', '') IS NULL THEN NULL ELSE (v_item->>'renditionGeneratedAt')::timestamptz END,
      CASE WHEN v_item ? 'renditionBytes' THEN (v_item->>'renditionBytes')::bigint ELSE NULL END
    );
  END LOOP;

  v_cover := v_normalized_media_items->0;
  UPDATE public.posts
  SET
    showcase_asset_path = nullif(btrim(coalesce(v_cover->>'storagePath', '')), ''),
    output_url = CASE
      WHEN nullif(btrim(coalesce(v_cover->>'storagePath', '')), '') IS NULL
        THEN nullif(btrim(coalesce(v_cover->>'externalUrl', '')), '')
      ELSE NULL
    END,
    category = CASE WHEN v_item_count = 0 THEN category WHEN v_cover->>'mediaKind' = 'video' THEN 'video' ELSE 'image' END,
    updated_at = timezone('utc'::text, now())
  WHERE id = p_post_id AND user_id = p_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role;

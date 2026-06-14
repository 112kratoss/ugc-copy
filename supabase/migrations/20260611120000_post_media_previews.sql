ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS preview_storage_path text;

ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_preview_storage_path_safe_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_preview_storage_path_safe_check CHECK (
    preview_storage_path IS NULL
    OR (
      preview_storage_path NOT LIKE '%..%'
      AND preview_storage_path !~ '[\\]'
      AND preview_storage_path !~ '^/'
    )
  );

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
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.posts
    WHERE id = p_post_id
      AND user_id = p_owner_user_id
      AND generation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Manual post not found or media is not editable.';
  END IF;

  IF jsonb_typeof(COALESCE(p_media_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Post media must be an array.';
  END IF;

  v_item_count := jsonb_array_length(COALESCE(p_media_items, '[]'::jsonb));
  IF v_item_count > 5 THEN
    RAISE EXCEPTION 'Posts support up to 5 media items.';
  END IF;

  DELETE FROM public.post_media
  WHERE post_id = p_post_id;

  FOR v_item IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_media_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.post_media (
      post_id,
      storage_path,
      preview_storage_path,
      external_url,
      media_kind,
      content_type,
      original_name,
      width,
      height,
      duration_seconds,
      sort_order
    )
    VALUES (
      p_post_id,
      nullif(btrim(coalesce(v_item->>'storagePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'previewStoragePath', '')), ''),
      nullif(btrim(coalesce(v_item->>'externalUrl', '')), ''),
      v_item->>'mediaKind',
      nullif(btrim(coalesce(v_item->>'contentType', '')), ''),
      nullif(btrim(coalesce(v_item->>'originalName', '')), ''),
      CASE WHEN v_item ? 'width' THEN (v_item->>'width')::integer ELSE NULL END,
      CASE WHEN v_item ? 'height' THEN (v_item->>'height')::integer ELSE NULL END,
      CASE WHEN v_item ? 'durationSeconds' THEN (v_item->>'durationSeconds')::numeric ELSE NULL END,
      (v_item->>'sortOrder')::integer
    );
  END LOOP;

  v_cover := COALESCE(p_media_items, '[]'::jsonb)->0;

  UPDATE public.posts
  SET
    showcase_asset_path = nullif(btrim(coalesce(v_cover->>'storagePath', '')), ''),
    output_url = CASE
      WHEN nullif(btrim(coalesce(v_cover->>'storagePath', '')), '') IS NULL
        THEN nullif(btrim(coalesce(v_cover->>'externalUrl', '')), '')
      ELSE NULL
    END,
    category = CASE
      WHEN v_item_count = 0 THEN category
      WHEN v_cover->>'mediaKind' = 'video' THEN 'video'
      ELSE 'image'
    END,
    updated_at = timezone('utc'::text, now())
  WHERE id = p_post_id
    AND user_id = p_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role;

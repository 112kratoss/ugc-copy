ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS preview_thumbhash text,
  ADD COLUMN IF NOT EXISTS preview_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS preview_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preview_error text,
  ADD COLUMN IF NOT EXISTS preview_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS creation_mode text;

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS preview_thumbhash text,
  ADD COLUMN IF NOT EXISTS preview_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS preview_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preview_error text,
  ADD COLUMN IF NOT EXISTS preview_generated_at timestamptz;

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS creation_mode text;

UPDATE public.generations
SET
  preview_status = 'pending',
  preview_generated_at = NULL
WHERE status = 'succeeded' AND output_url IS NOT NULL AND category IN ('image', 'video', 'motion', 'ugc-ad');

UPDATE public.post_media
SET
  preview_status = 'pending',
  preview_generated_at = NULL
WHERE storage_path IS NOT NULL;

UPDATE public.generations
SET creation_mode = 'motion', category = 'video'
WHERE category = 'motion';

UPDATE public.generations
SET category = CASE
  WHEN output_url ~* '(^generated_videos/|\.(mp4|mov|m4v|webm)(\?|$))' THEN 'video'
  ELSE 'image'
END
WHERE category = 'ugc-ad';

UPDATE public.posts
SET creation_mode = 'motion', category = 'video'
WHERE category = 'motion';

UPDATE public.posts AS post
SET category = CASE
  WHEN EXISTS (
    SELECT 1 FROM public.post_media AS media
    WHERE media.post_id = post.id AND media.media_kind = 'video'
  ) OR post.output_url ~* '\.(mp4|mov|m4v|webm)(\?|$)' THEN 'video'
  ELSE 'image'
END
WHERE post.category = 'ugc-ad';

ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_category_check,
  ADD CONSTRAINT generations_category_check CHECK (category IN ('image', 'video', 'audio')),
  DROP CONSTRAINT IF EXISTS generations_preview_status_check,
  ADD CONSTRAINT generations_preview_status_check CHECK (preview_status IN ('pending', 'processing', 'ready', 'failed')),
  DROP CONSTRAINT IF EXISTS generations_preview_attempt_count_check,
  ADD CONSTRAINT generations_preview_attempt_count_check CHECK (preview_attempt_count BETWEEN 0 AND 3),
  DROP CONSTRAINT IF EXISTS generations_creation_mode_check,
  ADD CONSTRAINT generations_creation_mode_check CHECK (creation_mode IS NULL OR creation_mode = 'motion');

ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_category_check,
  ADD CONSTRAINT posts_category_check CHECK (category IN ('image', 'video', 'text')),
  DROP CONSTRAINT IF EXISTS posts_creation_mode_check,
  ADD CONSTRAINT posts_creation_mode_check CHECK (creation_mode IS NULL OR creation_mode = 'motion');

ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_preview_status_check,
  ADD CONSTRAINT post_media_preview_status_check CHECK (preview_status IN ('pending', 'processing', 'ready', 'failed')),
  DROP CONSTRAINT IF EXISTS post_media_preview_attempt_count_check,
  ADD CONSTRAINT post_media_preview_attempt_count_check CHECK (preview_attempt_count BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS generations_preview_repair_idx
  ON public.generations (preview_status, preview_attempt_count, completed_at)
  WHERE status = 'succeeded' AND output_url IS NOT NULL AND category IN ('image', 'video');

CREATE INDEX IF NOT EXISTS post_media_preview_repair_idx
  ON public.post_media (preview_status, preview_attempt_count, created_at)
  WHERE storage_path IS NOT NULL;

COMMENT ON COLUMN public.generations.preview_thumbhash IS 'Base64 ThumbHash for the persisted preview derivative.';
COMMENT ON COLUMN public.generations.creation_mode IS 'Creation workflow metadata; motion outputs are still canonical video media.';

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
    SELECT 1 FROM public.posts
    WHERE id = p_post_id AND user_id = p_owner_user_id AND generation_id IS NULL
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

  DELETE FROM public.post_media WHERE post_id = p_post_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_media_items, '[]'::jsonb))
  LOOP
    INSERT INTO public.post_media (
      post_id, storage_path, preview_storage_path, preview_thumbhash, preview_status,
      preview_attempt_count, preview_error, preview_generated_at, external_url,
      media_kind, content_type, original_name, width, height, duration_seconds, sort_order
    ) VALUES (
      p_post_id,
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
    category = CASE WHEN v_item_count = 0 THEN category WHEN v_cover->>'mediaKind' = 'video' THEN 'video' ELSE 'image' END,
    updated_at = timezone('utc'::text, now())
  WHERE id = p_post_id AND user_id = p_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_post_media(uuid, uuid, jsonb) TO service_role;

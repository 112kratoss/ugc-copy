CREATE TABLE IF NOT EXISTS public.post_media (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  storage_path text,
  external_url text,
  media_kind text NOT NULL CHECK (media_kind IN ('image', 'video')),
  content_type text,
  original_name text,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  duration_seconds numeric CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order < 5),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT post_media_has_location_check CHECK (
    nullif(btrim(coalesce(storage_path, '')), '') IS NOT NULL
    OR nullif(btrim(coalesce(external_url, '')), '') IS NOT NULL
  ),
  CONSTRAINT post_media_storage_path_safe_check CHECK (
    storage_path IS NULL
    OR (
      storage_path NOT LIKE '%..%'
      AND storage_path !~ '[\\]'
      AND storage_path !~ '^/'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS post_media_post_sort_order_idx
  ON public.post_media (post_id, sort_order);

CREATE INDEX IF NOT EXISTS post_media_post_id_idx
  ON public.post_media (post_id);

CREATE INDEX IF NOT EXISTS post_media_kind_post_idx
  ON public.post_media (media_kind, post_id);

ALTER TABLE public.post_media ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Post media is viewable by owner or visible post" ON public.post_media;
CREATE POLICY "Post media is viewable by owner or visible post"
  ON public.post_media FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.posts posts
      WHERE posts.id = post_media.post_id
        AND (
          posts.visibility IN ('public', 'unlisted')
          OR posts.user_id = auth.uid()
        )
    )
  );

DROP POLICY IF EXISTS "Users can insert media for their own posts" ON public.post_media;
CREATE POLICY "Users can insert media for their own posts"
  ON public.post_media FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.posts posts
      WHERE posts.id = post_media.post_id
        AND posts.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can update media for their own posts" ON public.post_media;
CREATE POLICY "Users can update media for their own posts"
  ON public.post_media FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.posts posts
      WHERE posts.id = post_media.post_id
        AND posts.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.posts posts
      WHERE posts.id = post_media.post_id
        AND posts.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can delete media for their own posts" ON public.post_media;
CREATE POLICY "Users can delete media for their own posts"
  ON public.post_media FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.posts posts
      WHERE posts.id = post_media.post_id
        AND posts.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.post_media TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.post_media TO authenticated;

INSERT INTO public.post_media (
  post_id,
  storage_path,
  external_url,
  media_kind,
  content_type,
  original_name,
  sort_order
)
SELECT
  posts.id,
  nullif(btrim(coalesce(posts.showcase_asset_path, '')), ''),
  CASE
    WHEN nullif(btrim(coalesce(posts.showcase_asset_path, '')), '') IS NULL
      THEN nullif(btrim(coalesce(posts.output_url, '')), '')
    ELSE NULL
  END,
  CASE
    WHEN posts.category IN ('video', 'motion', 'ugc-ad') THEN 'video'
    ELSE 'image'
  END,
  NULL,
  COALESCE(
    NULLIF(regexp_replace(COALESCE(posts.showcase_asset_path, posts.output_url, ''), '^.*/', ''), ''),
    'media'
  ),
  0
FROM public.posts posts
WHERE posts.post_format <> 'text'
  AND (
    nullif(btrim(coalesce(posts.showcase_asset_path, '')), '') IS NOT NULL
    OR nullif(btrim(coalesce(posts.output_url, '')), '') IS NOT NULL
  )
ON CONFLICT (post_id, sort_order) DO NOTHING;

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

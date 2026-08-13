-- Teaser renditions for long-video feed autoplay.
--
-- A source longer than ~30s gets an additional 8s muted head encoded BEFORE
-- the full rendition: the short transcode never approaches the ffmpeg
-- timeout, so long sources whose full rendition dies still end up with
-- something the feed can stream instead of falling back to the raw source
-- (the egress amplifier this closes). Path presence is the ready signal —
-- the worker writes teaser_storage_path only after the content-hashed object
-- uploaded, so there is no path-without-object window and no status column.
-- teaser_error exists because a teaser failing while the full rendition
-- succeeds would otherwise leave zero trace (the ready update nulls
-- rendition_error).

ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS teaser_storage_path text,
  ADD COLUMN IF NOT EXISTS teaser_bytes bigint,
  ADD COLUMN IF NOT EXISTS teaser_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS teaser_error text;

-- Same traversal guard the preview and rendition paths carry.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_teaser_storage_path_safe_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_teaser_storage_path_safe_check CHECK (
    teaser_storage_path IS NULL
    OR (
      teaser_storage_path NOT LIKE '%..%'
      AND teaser_storage_path !~ '[\\]'
      AND teaser_storage_path !~ '^/'
    )
  );

-- The analog of ready-requires-path for a statusless column: a recorded path
-- must carry its generation time.
ALTER TABLE public.post_media
  DROP CONSTRAINT IF EXISTS post_media_teaser_path_requires_generated_at_check;

ALTER TABLE public.post_media
  ADD CONSTRAINT post_media_teaser_path_requires_generated_at_check CHECK (
    teaser_storage_path IS NULL OR teaser_generated_at IS NOT NULL
  );

-- replace_post_media deletes and re-inserts every row on edit, so an untouched
-- item has to carry its teaser across or every post edit would silently strip
-- teasers and force the sweep to redo them.
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
      rendition_error, rendition_generated_at, rendition_bytes,
      teaser_storage_path, teaser_bytes, teaser_generated_at, teaser_error
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
      CASE WHEN v_item ? 'renditionBytes' THEN (v_item->>'renditionBytes')::bigint ELSE NULL END,
      nullif(btrim(coalesce(v_item->>'teaserStoragePath', '')), ''),
      CASE WHEN v_item ? 'teaserBytes' THEN (v_item->>'teaserBytes')::bigint ELSE NULL END,
      CASE WHEN nullif(v_item->>'teaserGeneratedAt', '') IS NULL THEN NULL ELSE (v_item->>'teaserGeneratedAt')::timestamptz END,
      nullif(btrim(coalesce(v_item->>'teaserError', '')), '')
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

-- The claim RPC returns the existing teaser (and the probed duration) so a
-- worker never regenerates a teaser that already exists. Widening RETURNS
-- TABLE changes the function type, which CREATE OR REPLACE refuses — drop and
-- recreate, then re-issue the grants. The selection predicate is unchanged:
-- teaser work rides the same claimed attempt, gated by rendition_status only.
DROP FUNCTION IF EXISTS public.claim_media_rendition_repairs(integer, bigint, text, integer, integer);

CREATE FUNCTION public.claim_media_rendition_repairs(
  p_limit integer,
  p_byte_budget bigint,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  storage_path text,
  content_type text,
  rendition_attempt_count integer,
  source_bytes bigint,
  teaser_storage_path text,
  duration_seconds numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;
  RETURN QUERY
  WITH candidate_pool AS (
    SELECT
      pm.id,
      coalesce((objects.metadata->>'size')::bigint, 0) AS source_bytes,
      row_number() OVER (ORDER BY pm.created_at, pm.id) AS row_number,
      sum(coalesce((objects.metadata->>'size')::bigint, 0))
        OVER (ORDER BY pm.created_at, pm.id ROWS UNBOUNDED PRECEDING) AS running_bytes
    FROM public.post_media AS pm
    LEFT JOIN storage.objects AS objects
      ON objects.bucket_id = 'showcase_media' AND objects.name = pm.storage_path
    WHERE pm.media_kind = 'video'
      AND pm.storage_path IS NOT NULL
      AND pm.rendition_attempt_count < greatest(p_max_attempts, 1)
      AND (
        pm.rendition_status IN ('pending', 'failed')
        OR (
          pm.rendition_status = 'processing'
          AND (pm.rendition_locked_at IS NULL OR pm.rendition_locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
        )
      )
    ORDER BY pm.created_at, pm.id
    LIMIT least(greatest(p_limit, 1), 50)
  ), candidates AS (
    SELECT pm.id, pool.source_bytes
    FROM public.post_media AS pm
    JOIN candidate_pool AS pool ON pool.id = pm.id
    WHERE pool.row_number = 1 OR pool.running_bytes <= greatest(p_byte_budget, 1)
    ORDER BY pool.row_number
    FOR UPDATE OF pm SKIP LOCKED
  )
  UPDATE public.post_media AS pm
  SET rendition_status = 'processing', rendition_locked_at = now(), rendition_locked_by = p_locked_by
  FROM candidates
  WHERE pm.id = candidates.id
  RETURNING pm.id, pm.storage_path, pm.content_type, pm.rendition_attempt_count,
            candidates.source_bytes, pm.teaser_storage_path, pm.duration_seconds;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) TO service_role;

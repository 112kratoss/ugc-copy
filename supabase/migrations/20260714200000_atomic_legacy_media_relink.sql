-- Atomically relink legacy provider media after an operator has verified the
-- durable storage object. This RPC is intentionally service-role only.

CREATE OR REPLACE FUNCTION public.relink_legacy_generation_media(
  p_generation_id uuid,
  p_expected_output_url text,
  p_new_output_url text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_generation_changed boolean := false;
  v_posts_changed integer := 0;
  v_media_kind text;
  v_bucket_id text;
  v_object_name text;
  v_expected_content_type text;
  v_max_bytes bigint;
  v_storage_metadata jsonb;
  v_storage_size bigint;
BEGIN
  IF p_generation_id IS NULL
     OR nullif(btrim(coalesce(p_expected_output_url, '')), '') IS NULL
     OR nullif(btrim(coalesce(p_new_output_url, '')), '') IS NULL
     OR p_expected_output_url NOT LIKE 'https://tempfile.aiquickdraw.com/%' THEN
    RAISE EXCEPTION 'Invalid legacy media relink request';
  END IF;

  SELECT * INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Generation not found';
  END IF;
  IF v_generation.status IS DISTINCT FROM 'succeeded'
     OR v_generation.user_id IS NULL
     OR nullif(btrim(coalesce(v_generation.prediction_id, '')), '') IS NULL
     OR v_generation.prediction_id !~ '^[A-Za-z0-9_-]{1,200}$' THEN
    RAISE EXCEPTION 'Generation is not eligible for legacy media relinking';
  END IF;
  IF v_generation.output_url IS DISTINCT FROM p_expected_output_url
     AND v_generation.output_url IS DISTINCT FROM p_new_output_url THEN
    RAISE EXCEPTION 'Generation output changed before legacy media relinking';
  END IF;

  -- Mirror the operator's legacy media classification so the privileged RPC
  -- cannot cross-link image and video buckets even if called incorrectly.
  v_media_kind := CASE
    WHEN lower(coalesce(v_generation.category, '')) IN ('video', 'motion', 'ugc-ad')
      OR lower(coalesce(v_generation.model, '')) LIKE '%motion-control%'
      OR lower(coalesce(v_generation.model, '')) LIKE 'kling%'
      OR lower(split_part(split_part(p_expected_output_url, '?', 1), '#', 1)) ~ '\.(mp4|mov)$'
      THEN 'video'
    WHEN lower(coalesce(v_generation.category, '')) = 'image'
      OR lower(split_part(split_part(p_expected_output_url, '?', 1), '#', 1)) ~ '\.(jpg|jpeg|png|webp)$'
      THEN 'image'
    ELSE NULL
  END;
  IF v_media_kind IS NULL THEN
    RAISE EXCEPTION 'Generation media kind is not eligible for legacy media relinking';
  END IF;

  v_object_name := v_generation.user_id::text
    || '/generated_' || v_generation.prediction_id;
  IF v_media_kind = 'image' THEN
    v_bucket_id := 'generated_images';
    v_max_bytes := 25 * 1024 * 1024;
    CASE p_new_output_url
      WHEN v_bucket_id || '/' || v_object_name || '.jpg' THEN
        v_object_name := v_object_name || '.jpg';
        v_expected_content_type := 'image/jpeg';
      WHEN v_bucket_id || '/' || v_object_name || '.png' THEN
        v_object_name := v_object_name || '.png';
        v_expected_content_type := 'image/png';
      WHEN v_bucket_id || '/' || v_object_name || '.webp' THEN
        v_object_name := v_object_name || '.webp';
        v_expected_content_type := 'image/webp';
      ELSE
        RAISE EXCEPTION 'Durable image path is not bound to the generation owner and provider task';
    END CASE;
  ELSE
    v_bucket_id := 'generated_videos';
    v_max_bytes := 250 * 1024 * 1024;
    CASE p_new_output_url
      WHEN v_bucket_id || '/' || v_object_name || '.mp4' THEN
        v_object_name := v_object_name || '.mp4';
        v_expected_content_type := 'video/mp4';
      WHEN v_bucket_id || '/' || v_object_name || '.mov' THEN
        v_object_name := v_object_name || '.mov';
        v_expected_content_type := 'video/quicktime';
      ELSE
        RAISE EXCEPTION 'Durable video path is not bound to the generation owner and provider task';
    END CASE;
  END IF;

  -- Hold a row lock on the verified durable object until the database relink
  -- commits, preventing a concurrent storage deletion from opening a gap.
  SELECT objects.metadata INTO v_storage_metadata
  FROM storage.objects
  WHERE bucket_id = v_bucket_id
    AND name = v_object_name
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified durable media object does not exist';
  END IF;
  IF coalesce(v_storage_metadata->>'size', '') !~ '^[0-9]+$'
     OR lower(split_part(coalesce(v_storage_metadata->>'mimetype', ''), ';', 1))
        IS DISTINCT FROM v_expected_content_type THEN
    RAISE EXCEPTION 'Durable media metadata is invalid';
  END IF;
  v_storage_size := (v_storage_metadata->>'size')::bigint;
  IF v_storage_size <= 0 OR v_storage_size > v_max_bytes THEN
    RAISE EXCEPTION 'Durable media object size is invalid';
  END IF;

  -- Lock every linked post before validating or updating any of them. The
  -- generation and all posts now commit or roll back as one transaction.
  PERFORM id
  FROM public.posts
  WHERE generation_id = p_generation_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.posts
    WHERE generation_id = p_generation_id
      AND (
        user_id IS DISTINCT FROM v_generation.user_id
        OR (
          output_url IS NOT NULL
          AND output_url NOT IN (p_expected_output_url, p_new_output_url)
        )
      )
  ) THEN
    RAISE EXCEPTION 'A linked post conflicts with the requested legacy media relink';
  END IF;

  IF v_generation.output_url = p_expected_output_url THEN
    UPDATE public.generations
    SET output_url = p_new_output_url,
        preview_url = CASE WHEN preview_status = 'failed' THEN NULL ELSE preview_url END,
        preview_thumbhash = CASE WHEN preview_status = 'failed' THEN NULL ELSE preview_thumbhash END,
        preview_status = CASE WHEN preview_status = 'failed' THEN 'pending' ELSE preview_status END,
        preview_attempt_count = CASE WHEN preview_status = 'failed' THEN 0 ELSE preview_attempt_count END,
        preview_error = CASE WHEN preview_status = 'failed' THEN NULL ELSE preview_error END,
        preview_generated_at = CASE WHEN preview_status = 'failed' THEN NULL ELSE preview_generated_at END
    WHERE id = p_generation_id
      AND output_url = p_expected_output_url;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generation changed before legacy media relinking';
    END IF;
    v_generation_changed := true;
  END IF;

  UPDATE public.posts
  SET output_url = p_new_output_url,
      updated_at = timezone('utc'::text, now())
  WHERE generation_id = p_generation_id
    AND user_id = v_generation.user_id
    AND (output_url = p_expected_output_url OR output_url IS NULL);
  GET DIAGNOSTICS v_posts_changed = ROW_COUNT;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_generation_changed THEN 'relinked' ELSE 'already_relinked' END,
    'generation_id', p_generation_id,
    'generation_changed', v_generation_changed,
    'posts_changed', v_posts_changed,
    'output_url', p_new_output_url
  );
END;
$$;

REVOKE ALL ON FUNCTION public.relink_legacy_generation_media(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_legacy_generation_media(uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.relink_legacy_generation_media(uuid, text, text) IS
  'Service-only atomic relink of a succeeded generation and its linked posts from a verified legacy provider URL to the exact owner/task-scoped durable storage path.';

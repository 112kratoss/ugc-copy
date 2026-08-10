-- Preview/rendition selection used to be a read followed by an unconditional
-- `processing` update. Overlapping cron and publish after() invocations could
-- therefore download and transcode the same object concurrently. Add explicit
-- leases and atomic SKIP LOCKED claims for every repair surface.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS preview_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS preview_locked_by text;
ALTER TABLE public.post_media
  ADD COLUMN IF NOT EXISTS preview_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS preview_locked_by text,
  ADD COLUMN IF NOT EXISTS rendition_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS rendition_locked_by text;

CREATE OR REPLACE FUNCTION public.claim_generation_preview_repairs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  output_url text,
  category text,
  preview_attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT generation_rows.id
    FROM public.generations AS generation_rows
    WHERE generation_rows.status = 'succeeded'
      AND generation_rows.category IN ('image', 'video')
      AND generation_rows.output_url IS NOT NULL
      AND generation_rows.preview_attempt_count < greatest(p_max_attempts, 1)
      AND (
        generation_rows.preview_status IN ('pending', 'failed')
        OR (
          generation_rows.preview_status = 'processing'
          AND (generation_rows.preview_locked_at IS NULL OR generation_rows.preview_locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
        )
      )
    ORDER BY generation_rows.completed_at ASC NULLS LAST, generation_rows.id
    LIMIT least(greatest(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generations AS generation_rows
  SET preview_status = 'processing', preview_locked_at = now(), preview_locked_by = p_locked_by
  FROM candidates
  WHERE generation_rows.id = candidates.id
  RETURNING generation_rows.id, generation_rows.output_url, generation_rows.category,
            generation_rows.preview_attempt_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_post_media_preview_repairs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  storage_path text,
  media_kind text,
  content_type text,
  preview_attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT media_rows.id
    FROM public.post_media AS media_rows
    WHERE media_rows.storage_path IS NOT NULL
      AND media_rows.preview_attempt_count < greatest(p_max_attempts, 1)
      AND (
        media_rows.preview_status IN ('pending', 'failed')
        OR (
          media_rows.preview_status = 'processing'
          AND (media_rows.preview_locked_at IS NULL OR media_rows.preview_locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
        )
      )
    ORDER BY media_rows.created_at, media_rows.id
    LIMIT least(greatest(p_limit, 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.post_media AS media_rows
  SET preview_status = 'processing', preview_locked_at = now(), preview_locked_by = p_locked_by
  FROM candidates
  WHERE media_rows.id = candidates.id
  RETURNING media_rows.id, media_rows.storage_path, media_rows.media_kind,
            media_rows.content_type, media_rows.preview_attempt_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_media_rendition_repairs(
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
  source_bytes bigint
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
            candidates.source_bytes;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_generation_preview_repairs(integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_post_media_preview_repairs(integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_preview_repairs(integer, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_post_media_preview_repairs(integer, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) TO service_role;

-- Reserve a repair attempt when the row is claimed, not when the worker
-- finishes with it.
--
-- The three claim functions below set `processing` and take the lease but left
-- the attempt counter to the worker's own success or failure write. An
-- ordinary caught error still increments, so the nominal three-attempt budget
-- held for anything the worker could observe. A worker that never reaches that
-- write does not: a hard kill, an out-of-memory, or an invocation that runs out
-- of wall clock leaves the counter untouched, the lease lapses, and the same
-- row is admitted again on the next sweep with its budget intact.
--
-- The cost is egress, not CPU. These workers download the source before they
-- encode, so a row whose download outlives the function is re-read in full
-- every sweep, for as long as it keeps timing out. `claim_post_media_teaser_repair`
-- (20260905201219) already reserves its attempt on claim; this brings the other
-- three in line with it.
--
-- Whoever admits a row to work reserves the attempt. RETURNING now hands back
-- the incremented value, which is the ordinal of the run about to happen, and
-- the workers write that value rather than adding one to it.

CREATE OR REPLACE FUNCTION public.claim_generation_preview_repairs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE(id uuid, output_url text, category text, preview_attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT generation_rows.id
    FROM public.generations AS generation_rows
    WHERE generation_rows.status = 'succeeded'
      AND (
        generation_rows.category IN ('image', 'video')
        OR (generation_rows.category IS NULL AND (
          generation_rows.output_url LIKE 'generated\_images/%'
          OR generation_rows.output_url LIKE 'generated\_videos/%'
        ))
      )
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
  SET preview_status = 'processing',
      preview_locked_at = now(),
      preview_locked_by = p_locked_by,
      -- Reserved here so a worker that dies before its own write still spends
      -- the attempt. The candidate filter above bounds this by p_max_attempts.
      preview_attempt_count = generation_rows.preview_attempt_count + 1
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
RETURNS TABLE(id uuid, storage_path text, media_kind text, content_type text, preview_attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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
  SET preview_status = 'processing',
      preview_locked_at = now(),
      preview_locked_by = p_locked_by,
      preview_attempt_count = media_rows.preview_attempt_count + 1
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
RETURNS TABLE(id uuid, storage_path text, content_type text, rendition_attempt_count integer, source_bytes bigint, teaser_storage_path text, duration_seconds numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage', 'pg_temp'
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
  SET rendition_status = 'processing',
      rendition_locked_at = now(),
      rendition_locked_by = p_locked_by,
      -- A rendition downloads the whole source before it encodes, so this is
      -- the claim whose unbudgeted retry costs the most.
      rendition_attempt_count = pm.rendition_attempt_count + 1
  FROM candidates
  WHERE pm.id = candidates.id
  RETURNING pm.id, pm.storage_path, pm.content_type, pm.rendition_attempt_count,
            candidates.source_bytes, pm.teaser_storage_path, pm.duration_seconds;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_generation_preview_repairs(integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_post_media_preview_repairs(integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_preview_repairs(integer, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_post_media_preview_repairs(integer, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_media_rendition_repairs(integer, bigint, text, integer, integer) TO service_role;

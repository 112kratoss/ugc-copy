-- The rendition sweep (repairPostMediaRenditions) always runs the first row a
-- claim hands back, and releases the rows its time budget leaves unstarted. So
-- the claim has to hand its rows back oldest first, as it picks them. Its
-- UPDATE ... RETURNING returned them in whatever order the join read
-- post_media instead: under a hash join that is heap order, where a newer row's
-- version can sit before the queue head's. The sweep then ran the newer row and
-- released the head (seen in CI on #639; rendition_claim_queue_order.test.sql).
--
-- The claim now returns its rows in queue order. Which rows it claims, and
-- what it writes to them, are unchanged from 20260920190000.

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
      ON objects.bucket_id = CASE WHEN starts_with(pm.storage_path, 'private-posts/') THEN 'post_media' ELSE 'showcase_media' END AND objects.name = pm.storage_path
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
    SELECT pm.id, pool.source_bytes, pool.row_number
    FROM public.post_media AS pm
    JOIN candidate_pool AS pool ON pool.id = pm.id
    WHERE pool.row_number = 1 OR pool.running_bytes <= greatest(p_byte_budget, 1)
    ORDER BY pool.row_number
    FOR UPDATE OF pm SKIP LOCKED
  ), claimed AS (
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
              candidates.source_bytes, pm.teaser_storage_path, pm.duration_seconds,
              candidates.row_number AS queue_position
  )
  SELECT claimed.id, claimed.storage_path, claimed.content_type, claimed.rendition_attempt_count,
         claimed.source_bytes, claimed.teaser_storage_path, claimed.duration_seconds
  FROM claimed
  ORDER BY claimed.queue_position;
END;
$function$;

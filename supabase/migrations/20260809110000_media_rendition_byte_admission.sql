-- F14: byte-based admission control on media repair claims.
--
-- The sweep claimed by row count only, so twelve short clips and twelve 30 MB
-- clips looked identical at selection time. The wall-clock budget added by F2
-- stops the invocation overrunning, but it can only do so *after* the bytes
-- have already been committed to -- it aborts mid-batch rather than declining
-- to admit the work. Admitting by bytes is what makes the decision at the point
-- it can still be made cheaply.
--
-- The size comes from storage.objects rather than a column on post_media:
-- post_media records rendition_bytes (the *output*, written after transcoding)
-- and nothing for the source. Joining keeps Storage authoritative instead of
-- introducing a denormalised copy that can drift from the object it describes.

CREATE OR REPLACE FUNCTION public.list_media_rendition_repair_candidates(
  p_limit integer DEFAULT 12,
  p_byte_budget bigint DEFAULT 268435456,
  p_max_attempts integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  storage_path text,
  content_type text,
  rendition_attempt_count integer,
  source_bytes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
  WITH candidates AS (
    SELECT
      pm.id,
      pm.storage_path,
      pm.content_type,
      pm.rendition_attempt_count,
      -- A row whose object is missing is a broken row: the repair will fail on
      -- download without ever reaching ffmpeg, so it costs no transcode budget
      -- and counting it as zero lets those drain to their failure state instead
      -- of blocking the queue behind an imaginary cost.
      coalesce((o.metadata->>'size')::bigint, 0) AS source_bytes,
      row_number() OVER (ORDER BY pm.created_at ASC, pm.id ASC) AS rn,
      sum(coalesce((o.metadata->>'size')::bigint, 0))
        OVER (ORDER BY pm.created_at ASC, pm.id ASC ROWS UNBOUNDED PRECEDING) AS running_bytes
    FROM public.post_media pm
    LEFT JOIN storage.objects o
      ON o.bucket_id = 'showcase_media'
     AND o.name = pm.storage_path
    WHERE pm.media_kind = 'video'
      AND pm.rendition_status IN ('pending', 'processing', 'failed')
      AND coalesce(pm.rendition_attempt_count, 0) < greatest(coalesce(p_max_attempts, 3), 1)
      AND pm.storage_path IS NOT NULL
    ORDER BY pm.created_at ASC, pm.id ASC
    LIMIT least(greatest(coalesce(p_limit, 12), 1), 50)
  )
  SELECT
    candidates.id,
    candidates.storage_path,
    candidates.content_type,
    candidates.rendition_attempt_count,
    candidates.source_bytes
  FROM candidates
  -- rn = 1 always passes: a single object larger than the whole budget would
  -- otherwise never be admitted and would wedge the queue head permanently,
  -- since rows are taken oldest-first. Its cost is still bounded by the sweep's
  -- wall clock and by ffmpeg's own SIGKILL timeout.
  WHERE candidates.rn = 1
     OR candidates.running_bytes <= greatest(coalesce(p_byte_budget, 268435456), 1)
  ORDER BY candidates.rn;
$$;

REVOKE ALL ON FUNCTION public.list_media_rendition_repair_candidates(integer, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_media_rendition_repair_candidates(integer, bigint, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_media_rendition_repair_candidates(integer, bigint, integer) TO service_role;

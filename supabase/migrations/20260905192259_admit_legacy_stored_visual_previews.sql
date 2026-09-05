-- Admit legacy durable image/video outputs with no category, using the same
-- bounded leases and retry budget. Rebuild the partial index for this predicate.
drop index if exists "public"."generations_preview_repair_idx";

CREATE INDEX generations_preview_repair_idx ON public.generations USING btree (preview_status, preview_attempt_count, completed_at) WHERE ((status = 'succeeded'::text) AND (output_url IS NOT NULL) AND ((category = ANY (ARRAY['image'::text, 'video'::text])) OR ((category IS NULL) AND ((output_url ~~ 'generated\_images/%'::text) OR (output_url ~~ 'generated\_videos/%'::text)))));


CREATE OR REPLACE FUNCTION public.claim_generation_preview_repairs(p_limit integer, p_locked_by text, p_lock_ttl_seconds integer DEFAULT 300, p_max_attempts integer DEFAULT 3)
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
  SET preview_status = 'processing', preview_locked_at = now(), preview_locked_by = p_locked_by
  FROM candidates
  WHERE generation_rows.id = candidates.id
  RETURNING generation_rows.id, generation_rows.output_url, generation_rows.category,
            generation_rows.preview_attempt_count;
END;
$function$
;

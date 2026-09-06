alter table "public"."generations" add column "playback_rendition_attempt_count" integer not null default 0;

alter table "public"."generations" add column "playback_rendition_bytes" bigint;

alter table "public"."generations" add column "playback_rendition_error" text;

alter table "public"."generations" add column "playback_rendition_generated_at" timestamp with time zone;

alter table "public"."generations" add column "playback_rendition_locked_at" timestamp with time zone;

alter table "public"."generations" add column "playback_rendition_locked_by" text;

alter table "public"."generations" add column "playback_rendition_path" text;

alter table "public"."generations" add column "playback_rendition_source" text;

alter table "public"."generations" add column "playback_rendition_status" text not null default 'pending'::text;

CREATE INDEX generation_playback_pending_idx ON public.generations USING btree (completed_at, id) WHERE ((status = 'succeeded'::text) AND starts_with(output_url, 'generated_videos/'::text) AND (playback_rendition_status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text])) AND (playback_rendition_attempt_count < 3));

alter table "public"."generations" add constraint "generation_playback_attempt_check" CHECK (((playback_rendition_attempt_count >= 0) AND (playback_rendition_attempt_count <= 3))) not valid;

alter table "public"."generations" validate constraint "generation_playback_attempt_check";

alter table "public"."generations" add constraint "generation_playback_path_check" CHECK (((playback_rendition_path IS NULL) OR (playback_rendition_path ~ (((('^generated_videos/'::text || (user_id)::text) || '/playback/'::text) || (id)::text) || '/[a-f0-9]+[.]mp4$'::text)))) not valid;

alter table "public"."generations" validate constraint "generation_playback_path_check";

alter table "public"."generations" add constraint "generation_playback_ready_check" CHECK (((playback_rendition_status <> 'ready'::text) OR ((playback_rendition_path IS NOT NULL) AND (playback_rendition_source IS NOT NULL) AND (playback_rendition_bytes > 0) AND (playback_rendition_bytes IS NOT NULL) AND (playback_rendition_generated_at IS NOT NULL)))) not valid;

alter table "public"."generations" validate constraint "generation_playback_ready_check";

alter table "public"."generations" add constraint "generation_playback_status_check" CHECK ((playback_rendition_status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'skipped'::text]))) not valid;

alter table "public"."generations" validate constraint "generation_playback_status_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.claim_generation_playback_rendition(p_locked_by text, p_max_bytes bigint DEFAULT 67108864)
 RETURNS TABLE(id uuid, user_id uuid, output_url text, source_bytes bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF nullif(btrim(p_locked_by),'') IS NULL THEN RAISE EXCEPTION 'Playback lease owner is required'; END IF;
  RETURN QUERY
  WITH candidate AS MATERIALIZED (
    SELECT g.id, sz.bytes
    FROM public.generations g
    JOIN storage.objects obj ON obj.bucket_id = 'generated_videos' AND g.output_url = 'generated_videos/' || obj.name
    CROSS JOIN LATERAL (SELECT CASE WHEN obj.metadata->>'size' ~ '^[0-9]{1,18}$'
      THEN (obj.metadata->>'size')::bigint ELSE NULL END AS bytes) sz
    WHERE g.status = 'succeeded' AND starts_with(g.output_url, 'generated_videos/')
      AND starts_with(obj.name, g.user_id::text || '/')
      AND obj.name !~ '(^|/)[.][.]?(/|$)' AND position(chr(92) IN obj.name) = 0
      AND position('//' IN obj.name) = 0 AND position('%' IN obj.name) = 0
      AND g.playback_rendition_status IN ('pending','processing','failed')
      AND g.playback_rendition_attempt_count < 3
      AND (g.playback_rendition_locked_at IS NULL OR g.playback_rendition_locked_at < now() - interval '10 minutes')
      AND sz.bytes > 0 AND sz.bytes <= least(coalesce(p_max_bytes,67108864),67108864)
    ORDER BY g.completed_at NULLS LAST, g.id
    LIMIT 1 FOR UPDATE OF g SKIP LOCKED
  )
  UPDATE public.generations g SET playback_rendition_status = 'processing',
    playback_rendition_locked_at = now(), playback_rendition_locked_by = p_locked_by,
    playback_rendition_attempt_count = g.playback_rendition_attempt_count + 1
  FROM candidate c WHERE g.id = c.id
  RETURNING g.id, g.user_id, g.output_url, c.bytes;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.has_pending_generation_playback_rendition()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$ SELECT EXISTS (
    SELECT 1
    FROM public.generations g
    JOIN storage.objects obj ON obj.bucket_id = 'generated_videos' AND g.output_url = 'generated_videos/' || obj.name
    CROSS JOIN LATERAL (SELECT CASE WHEN obj.metadata->>'size' ~ '^[0-9]{1,18}$'
      THEN (obj.metadata->>'size')::bigint ELSE NULL END AS bytes) sz
    WHERE g.status = 'succeeded' AND starts_with(g.output_url, 'generated_videos/')
      AND starts_with(obj.name, g.user_id::text || '/')
      AND obj.name !~ '(^|/)[.][.]?(/|$)' AND position(chr(92) IN obj.name) = 0
      AND position('//' IN obj.name) = 0 AND position('%' IN obj.name) = 0
      AND g.playback_rendition_status IN ('pending','processing','failed')
      AND g.playback_rendition_attempt_count < 3
      AND (g.playback_rendition_locked_at IS NULL OR g.playback_rendition_locked_at < now() - interval '10 minutes')
      AND sz.bytes > 0 AND sz.bytes <= 67108864
); $function$
;


-- Local schema diff omits ACLs; these entry points and metadata are service-only.
REVOKE ALL ON FUNCTION public.claim_generation_playback_rendition(text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_playback_rendition(text,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.has_pending_generation_playback_rendition() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_pending_generation_playback_rendition() TO service_role;

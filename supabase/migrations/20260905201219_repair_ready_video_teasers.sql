-- Captured from the isolated local database. Repair teasers independently of ready full renditions.
alter table "public"."post_media" add column "teaser_attempt_count" integer not null default 0;

alter table "public"."post_media" add column "teaser_locked_at" timestamp with time zone;

alter table "public"."post_media" add column "teaser_locked_by" text;

CREATE INDEX post_media_teaser_repair_idx ON public.post_media USING btree (created_at, id) WHERE ((media_kind = 'video'::text) AND (rendition_status = 'ready'::text) AND (duration_seconds > (30)::numeric) AND (teaser_storage_path IS NULL) AND (teaser_attempt_count < 3));

alter table "public"."post_media" add constraint "post_media_teaser_attempt_count_check" CHECK (((teaser_attempt_count >= 0) AND (teaser_attempt_count <= 3))) not valid;

alter table "public"."post_media" validate constraint "post_media_teaser_attempt_count_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.claim_post_media_teaser_repair(p_locked_by text, p_max_bytes bigint DEFAULT 33554432)
 RETURNS TABLE(id uuid, post_id uuid, rendition_storage_path text, source_bytes bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if nullif(btrim(p_locked_by), '') is null then
    raise exception 'A teaser lease owner is required';
  end if;
  return query
  with candidate as materialized (
    select pm.id, sz.bytes
    from public.post_media pm
    join storage.objects obj on obj.bucket_id = 'showcase_media' and obj.name = pm.rendition_storage_path
    cross join lateral (select case
      when obj.metadata->>'size' ~ '^[0-9]{1,18}$' then (obj.metadata->>'size')::bigint
      else null end as bytes) sz
    where pm.media_kind = 'video' and pm.rendition_status = 'ready'
      and pm.duration_seconds > 30 and pm.teaser_storage_path is null and pm.teaser_attempt_count < 3
      and (pm.teaser_locked_at is null or pm.teaser_locked_at < now() - interval '5 minutes')
      and starts_with(pm.rendition_storage_path, 'posts/' || pm.post_id::text || '/')
      and sz.bytes > 0 and sz.bytes <= least(coalesce(p_max_bytes, 33554432), 33554432)
    order by pm.created_at, pm.id
    limit 1 for update of pm skip locked
  )
  update public.post_media pm
  set teaser_locked_at = now(), teaser_locked_by = p_locked_by,
      teaser_attempt_count = pm.teaser_attempt_count + 1
  from candidate c where pm.id = c.id
  returning pm.id, pm.post_id, pm.rendition_storage_path, c.bytes;
end;
$function$
;




-- Schema diff omits function ACLs; keep worker admission service-only.
revoke all on function public.claim_post_media_teaser_repair(text, bigint) from public, anon, authenticated;
grant execute on function public.claim_post_media_teaser_repair(text, bigint) to service_role;

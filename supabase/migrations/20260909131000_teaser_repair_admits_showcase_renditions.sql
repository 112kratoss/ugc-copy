-- Let the teaser sweep see videos that were published from a creation.
--
-- `claim_post_media_teaser_repair` admitted only renditions filed under
-- `posts/<post id>/`. A post published from a generation keeps its media under
-- `showcase/<generation id>/` instead — the derivative the publish path copies
-- there, with its `.feed.` rendition beside it — so the sweep walked straight
-- past every such video. No user has published a clip over 30 s from a
-- creation yet, which is the only reason this never showed; the day one does,
-- it would silently get no teaser and every feed card would stream the full
-- rendition.
--
-- The claim now also admits `showcase/<generation id>/` when the owning post
-- links that generation, and returns the generation id so the worker can hold
-- the same ownership check the database applied. Returning a new column means
-- the function has to be dropped and recreated: `CREATE OR REPLACE` refuses a
-- changed result type. Argument types are unchanged, so callers and the
-- privilege assertions keyed on `(text, bigint)` are untouched.

set check_function_bodies = off;

DROP FUNCTION IF EXISTS public.claim_post_media_teaser_repair(text, bigint);

CREATE FUNCTION public.claim_post_media_teaser_repair(p_locked_by text, p_max_bytes bigint DEFAULT 33554432)
 RETURNS TABLE(id uuid, post_id uuid, generation_id uuid, rendition_storage_path text, source_bytes bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if nullif(btrim(p_locked_by), '') is null then
    raise exception 'A teaser lease owner is required';
  end if;
  return query
  with candidate as materialized (
    select pm.id, p.generation_id, sz.bytes
    from public.post_media pm
    join public.posts p on p.id = pm.post_id
    join storage.objects obj on obj.bucket_id = 'showcase_media' and obj.name = pm.rendition_storage_path
    cross join lateral (select case
      when obj.metadata->>'size' ~ '^[0-9]{1,18}$' then (obj.metadata->>'size')::bigint
      else null end as bytes) sz
    where pm.media_kind = 'video' and pm.rendition_status = 'ready'
      and pm.duration_seconds > 30 and pm.teaser_storage_path is null and pm.teaser_attempt_count < 3
      and (pm.teaser_locked_at is null or pm.teaser_locked_at < now() - interval '5 minutes')
      and (
        starts_with(pm.rendition_storage_path, 'posts/' || pm.post_id::text || '/')
        or (
          p.generation_id is not null
          and starts_with(pm.rendition_storage_path, 'showcase/' || p.generation_id::text || '/')
        )
      )
      and sz.bytes > 0 and sz.bytes <= least(coalesce(p_max_bytes, 33554432), 33554432)
    order by pm.created_at, pm.id
    limit 1 for update of pm skip locked
  )
  update public.post_media pm
  set teaser_locked_at = now(), teaser_locked_by = p_locked_by,
      teaser_attempt_count = pm.teaser_attempt_count + 1
  from candidate c where pm.id = c.id
  returning pm.id, pm.post_id, c.generation_id, pm.rendition_storage_path, c.bytes;
end;
$function$;

-- A dropped function loses its ACL; keep worker admission service-only.
revoke all on function public.claim_post_media_teaser_repair(text, bigint) from public, anon, authenticated;
grant execute on function public.claim_post_media_teaser_repair(text, bigint) to service_role;

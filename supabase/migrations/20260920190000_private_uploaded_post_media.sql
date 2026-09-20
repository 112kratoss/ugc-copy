-- Uploaded posts must not expose private originals through a public bucket.
-- Path namespaces preserve bucket identity in existing snapshots/manifests.
-- Existing public objects are moved by the separately resumable operator job.
insert into storage.buckets(id, name, public) values ('post_media', 'post_media', false)
on conflict(id) do update set public = false;

-- No Storage client policies: all writes are admitted by the publishing API;
-- read capabilities are minted only after this current-state authorization.
create or replace function public.can_read_private_post_media(p_path text, p_viewer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select starts_with(p_path, 'private-posts/') and (
    exists (
      select 1 from public.posts p
      join public.profiles owner on owner.id = p.user_id
      where p.id = split_part(p_path, '/', 2)::uuid
        and starts_with(p_path, 'private-posts/' || p.id::text || '/')
        and owner.identity_state not in ('deleting', 'deleted', 'merged')
        and (p.showcase_asset_path = p_path or exists (
          select 1 from public.post_media m where m.post_id = p.id
          and p_path = any(array[m.storage_path, m.preview_storage_path,
            m.display_storage_path, m.rendition_storage_path, m.teaser_storage_path])
        ))
        and (p.user_id = p_viewer_id or (
          p.visibility in ('public','unlisted') and p.archived_at is null
          and p.review_status = 'visible' and p.tombstoned_at is null
          and not exists (select 1 from public.user_blocks b where
            (b.blocker_user_id = p_viewer_id and b.blocked_user_id = p.user_id)
            or (b.blocker_user_id = p.user_id and b.blocked_user_id = p_viewer_id))
        ))
    ) or exists (
      -- Checkout pins its exact media. Edits/archive/tombstone retain it;
      -- a moderation takedown retracts it, including detached purchases.
      select 1 from public.post_resource_purchase_media m
      join public.post_resource_bundle_purchases purchase on purchase.id = m.purchase_id
      where purchase.buyer_user_id = p_viewer_id
        and purchase.moderation_retracted_at is null
        and p_path = any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
    )
  );
$$;
revoke all on function public.can_read_private_post_media(text, uuid) from public, anon, authenticated;
grant execute on function public.can_read_private_post_media(text, uuid) to service_role;

-- Extend account deletion to private originals and every derivative.
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_showcase_paths jsonb;
  v_template_prefixes jsonb;
  v_manifest jsonb;
  v_job public.account_deletion_jobs%ROWTYPE;
  v_owner_ids uuid[];
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('account-deletion:' || p_user_id::text, 0)
  );

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF FOUND AND v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'status', 'already_completed',
      'user_id', p_user_id,
      'attempt_count', v_job.attempt_count,
      'storage_manifest', v_job.storage_manifest
    );
  END IF;

  IF FOUND
    AND jsonb_typeof(v_job.storage_manifest->'owner_user_ids') = 'array'
    AND jsonb_array_length(v_job.storage_manifest->'owner_user_ids') > 0 THEN
    SELECT array_agg(value::uuid ORDER BY value::uuid)
    INTO v_owner_ids
    FROM jsonb_array_elements_text(
      v_job.storage_manifest->'owner_user_ids'
    ) AS persisted(value);

    UPDATE public.profiles
    SET identity_state = 'deleting'
    WHERE id = ANY(v_owner_ids)
      AND identity_state <> 'deleting';

    UPDATE public.account_deletion_jobs
    SET attempt_count = attempt_count + 1,
        last_attempt_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id
    RETURNING * INTO v_job;

    RETURN jsonb_build_object(
      'status', 'prepared',
      'user_id', v_job.user_id,
      'attempt_count', v_job.attempt_count,
      'storage_manifest', v_job.storage_manifest
    );
  END IF;

  -- Lock every current member and the target deterministically. The profile
  -- trigger prevents a concurrent merge from adding another guest after the
  -- target moves to deleting.
  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id OR merged_into_user_id = p_user_id
  ORDER BY id
  FOR UPDATE;

  SELECT array_agg(owner.id ORDER BY owner.id)
  INTO v_owner_ids
  FROM (
    SELECT p_user_id AS id
    UNION
    SELECT id
    FROM public.profiles
    WHERE merged_into_user_id = p_user_id
  ) AS owner;

  UPDATE public.profiles
  SET identity_state = 'deleting'
  WHERE id = ANY(v_owner_ids)
    AND identity_state <> 'deleting';

  SELECT coalesce(jsonb_agg(distinct path ORDER BY path), '[]'::jsonb)
  INTO v_showcase_paths
  FROM (
    SELECT g.showcase_asset_path AS path FROM public.generations g
    WHERE g.user_id = any(v_owner_ids)
      AND starts_with(btrim(g.showcase_asset_path), 'showcase/' || g.id::text || '/')
    UNION
    SELECT paths.path FROM public.posts p
    CROSS JOIN LATERAL (
      SELECT p.showcase_asset_path AS path
      UNION SELECT o.name FROM storage.objects o WHERE o.bucket_id='post_media'
        AND starts_with(o.name, 'private-posts/' || p.id::text || '/')
      UNION SELECT unnest(array[m.storage_path,m.preview_storage_path,m.display_storage_path,
        m.rendition_storage_path,m.teaser_storage_path]) FROM public.post_media m WHERE m.post_id = p.id
      UNION SELECT unnest(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])
        FROM public.post_resource_purchase_media m
        JOIN public.post_resource_bundle_purchases purchase ON purchase.id=m.purchase_id
        JOIN public.post_resource_bundles bundle ON bundle.id=purchase.bundle_id
        WHERE bundle.post_id=p.id
    ) paths
    WHERE p.user_id = any(v_owner_ids) AND (
      starts_with(btrim(paths.path), 'posts/' || p.id::text || '/')
      OR starts_with(btrim(paths.path), 'private-posts/' || p.id::text || '/')
      OR (starts_with(btrim(paths.path), 'showcase/' || p.generation_id::text || '/') AND EXISTS (
        SELECT 1 FROM public.generations g WHERE g.id=p.generation_id AND g.user_id=any(v_owner_ids)
      ))
    )
  ) owned_paths;

  SELECT coalesce(jsonb_agg(template.id::text ORDER BY template.id::text), '[]'::jsonb)
  INTO v_template_prefixes
  FROM public.templates AS template
  WHERE template.creator_user_id = ANY(v_owner_ids);

  v_manifest := jsonb_build_object(
    'owner_user_ids', to_jsonb(v_owner_ids),
    'user_prefix_buckets', jsonb_build_array(
      'profiles',
      'uploads',
      'generated_images',
      'generated_videos',
      'generated_audio',
      'generation_inputs',
      'post_resource_files',
      'template_inputs'
    ),
    'showcase_media_paths', v_showcase_paths,
    'template_asset_prefixes', v_template_prefixes,
    'retention_policy', jsonb_build_object(
      'user_private_media', 'delete',
      'showcase_media', 'delete',
      'template_assets', 'delete',
      'template_database_snapshots', 'anonymize'
    )
  );

  INSERT INTO public.account_deletion_jobs (
    user_id,
    status,
    storage_manifest,
    attempt_count,
    last_error,
    requested_at,
    last_attempt_at,
    updated_at
  ) VALUES (
    p_user_id,
    'requested',
    v_manifest,
    1,
    NULL,
    timezone('utc'::text, now()),
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  )
  ON CONFLICT (user_id) DO UPDATE
  SET storage_manifest = EXCLUDED.storage_manifest,
      attempt_count = public.account_deletion_jobs.attempt_count + 1,
      last_error = NULL,
      last_attempt_at = timezone('utc'::text, now()),
      updated_at = timezone('utc'::text, now())
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', 'prepared',
    'user_id', v_job.user_id,
    'attempt_count', v_job.attempt_count,
    'storage_manifest', v_job.storage_manifest
  );
END;
$$;


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


CREATE OR REPLACE FUNCTION public.claim_post_media_teaser_repair(p_locked_by text, p_max_bytes bigint DEFAULT 33554432)
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
    join storage.objects obj on obj.bucket_id = case when starts_with(pm.rendition_storage_path, 'private-posts/') then 'post_media' else 'showcase_media' end and obj.name = pm.rendition_storage_path
    cross join lateral (select case
      when obj.metadata->>'size' ~ '^[0-9]{1,18}$' then (obj.metadata->>'size')::bigint
      else null end as bytes) sz
    where pm.media_kind = 'video' and pm.rendition_status = 'ready'
      and pm.duration_seconds > 30 and pm.teaser_storage_path is null and pm.teaser_attempt_count < 3
      and (pm.teaser_locked_at is null or pm.teaser_locked_at < now() - interval '5 minutes')
      and (
        starts_with(pm.rendition_storage_path, 'posts/' || pm.post_id::text || '/')
        or starts_with(pm.rendition_storage_path, 'private-posts/' || pm.post_id::text || '/')
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


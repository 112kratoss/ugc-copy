-- A post whose creation was deleted keeps serving the creation's copy. Deleting
-- a creation that has a post leaves its folder (showcase/<generation>/, or
-- private-posts/<generation>/ for one marked NSFW) and its private original in
-- place for the post (generation-delete-service), and posts.generation_id is
-- ON DELETE SET NULL. Every rule that decides which folder is a post's asked
-- generation_id, so once it was NULL:
--   - making the post private or deleting it queued nothing, and the copy
--     stayed public: sync_generation_exposure_with_post returned at the NULL
--     link (the app's own deletes skipped it for the same reason);
--   - account erasure's manifest skipped the copy;
--   - marking the post NSFW, and reading its private copy, were refused;
--   - the teaser sweep never admitted its rendition.
-- PR #598 let a take-down prove such a folder by searching every post for it.
--
-- 1. posts.deleted_generation_id records the creation whose delete unlinked the
--    post, in that delete's own statement. A trigger owns the column.
-- 2. Each of those rules keys on coalesce(generation_id, deleted_generation_id).
-- 3. Posts unlinked before this migration are backfilled where #598's proof
--    holds. Production had none (read-only count, 2026-10-30).

ALTER TABLE public.posts
  ADD COLUMN deleted_generation_id uuid;

-- A post links a live creation or names a deleted one, never both.
ALTER TABLE public.posts
  ADD CONSTRAINT posts_deleted_generation_unlinked
  CHECK (generation_id IS NULL OR deleted_generation_id IS NULL);

-- The private media read looks a path's folder up by it.
CREATE INDEX posts_deleted_generation_id_idx
  ON public.posts (deleted_generation_id)
  WHERE deleted_generation_id IS NOT NULL;

COMMENT ON COLUMN public.posts.deleted_generation_id IS
  'The creation whose delete unlinked this post (generation_id is ON DELETE SET NULL). The post keeps serving that creation''s copy from showcase/<id>/ or private-posts/<id>/, and the rules deciding which folder is the post''s key on coalesce(generation_id, deleted_generation_id). Written only by posts_record_deleted_generation.';

-- Posts unlinked before this migration, where PR #598's proof holds
-- (readDeletedGenerationId, src/lib/moderation-ops.ts): exactly one creation
-- folder among the post's own paths, no creation by that id, and no other post
-- or media row naming a path in it. A post left out keeps today's behaviour.
WITH named AS (
  SELECT
    posts.id AS post_id,
    (regexp_match(
      paths.path,
      '(?:^|/)(?:showcase|private-posts)/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/'
    ))[1]::uuid AS folder_id
  FROM public.posts AS posts
  CROSS JOIN LATERAL (
    SELECT posts.showcase_asset_path AS path
    UNION ALL
    SELECT posts.output_url
    UNION ALL
    SELECT unnest(ARRAY[
      media.storage_path, media.preview_storage_path, media.display_storage_path,
      media.rendition_storage_path, media.teaser_storage_path
    ])
    FROM public.post_media AS media
    WHERE media.post_id = posts.id
  ) AS paths
  WHERE posts.generation_id IS NULL
),
proven AS (
  SELECT named.post_id, (array_agg(DISTINCT named.folder_id))[1] AS folder_id
  FROM named
  WHERE named.folder_id IS NOT NULL
    AND named.folder_id <> named.post_id
  GROUP BY named.post_id
  HAVING count(DISTINCT named.folder_id) = 1
)
UPDATE public.posts AS posts
SET deleted_generation_id = proven.folder_id
FROM proven
WHERE posts.id = proven.post_id
  AND NOT EXISTS (
    SELECT 1
    FROM public.generations AS generations
    WHERE generations.id = proven.folder_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.posts AS other
    CROSS JOIN LATERAL unnest(ARRAY[other.showcase_asset_path, other.output_url]) AS named_path(path)
    WHERE other.id <> proven.post_id
      AND named_path.path LIKE ('%/' || proven.folder_id::text || '/%')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.post_media AS media
    CROSS JOIN LATERAL unnest(ARRAY[
      media.storage_path, media.preview_storage_path, media.display_storage_path,
      media.rendition_storage_path, media.teaser_storage_path
    ]) AS named_path(path)
    WHERE media.post_id <> proven.post_id
      AND named_path.path LIKE ('%/' || proven.folder_id::text || '/%')
  );

-- The column follows the link, whoever writes the post. The FK's SET NULL is an
-- UPDATE OF generation_id that runs once the creation's row is gone, which tells
-- a deleted creation from a link removed by hand: only the first is recorded.
-- A live link clears it, and no other write can set or change it.
CREATE FUNCTION public.record_deleted_post_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.generation_id IS NOT NULL THEN
    NEW.deleted_generation_id := NULL;
  ELSIF OLD.generation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.generations AS generations
      WHERE generations.id = OLD.generation_id
    ) THEN
    NEW.deleted_generation_id := OLD.generation_id;
  ELSE
    NEW.deleted_generation_id := OLD.deleted_generation_id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.record_deleted_post_generation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_deleted_post_generation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.record_deleted_post_generation() IS
  'Trusted posts trigger: records the creation whose delete unlinked the post in deleted_generation_id, and keeps every other write off that column.';

CREATE TRIGGER posts_record_deleted_generation
BEFORE INSERT OR UPDATE OF generation_id, deleted_generation_id
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.record_deleted_post_generation();

-- 20261015054611's body, which returned at the NULL link: a post whose creation
-- was deleted now queues the copy it stops needing under the folder it
-- recorded. Owner, grants and comment as before.
CREATE OR REPLACE FUNCTION public.sync_generation_exposure_with_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post_id uuid;
  v_generation_id uuid;
  v_deleted_generation_id uuid;
  v_owner_user_id uuid;
  v_new_path text;
  v_generation_path text;
  v_dropped_path text;
  v_reason text;
  v_exposed boolean := false;
  v_is_public boolean := false;
  v_path text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Account erasure deletes posts through a cascade, and its own sweep owns
    -- that media. Only a direct delete is handled here.
    IF pg_trigger_depth() > 1 THEN
      RETURN NULL;
    END IF;

    v_post_id := OLD.id;
    v_generation_id := OLD.generation_id;
    v_deleted_generation_id := OLD.deleted_generation_id;
    v_owner_user_id := OLD.user_id;
    v_dropped_path := OLD.showcase_asset_path;
    v_reason := 'post_deleted';
  ELSE
    v_post_id := NEW.id;
    v_generation_id := NEW.generation_id;
    v_deleted_generation_id := NEW.deleted_generation_id;
    v_owner_user_id := NEW.user_id;
    v_new_path := NEW.showcase_asset_path;
    v_exposed := NEW.visibility <> 'private' AND NEW.archived_at IS NULL;
    -- Hidden content can never be public: generations_prevent_hidden_republish
    -- raises on that, and would roll the post write back with it.
    v_is_public := NEW.visibility = 'public'
      AND NEW.archived_at IS NULL
      AND coalesce(NEW.review_status, 'visible') <> 'hidden';

    IF TG_OP = 'UPDATE' THEN
      -- A generation the post stops linking to loses the post's exposure.
      IF OLD.generation_id IS NOT NULL AND OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
        UPDATE public.generations AS generations
        SET is_public = false,
            showcase_asset_path = NULL
        WHERE generations.id = OLD.generation_id
          AND (
            generations.user_id = OLD.user_id
            OR EXISTS (
              SELECT 1
              FROM public.profiles AS owner
              WHERE owner.id = generations.user_id
                AND owner.merged_into_user_id = OLD.user_id
            )
          )
          AND generations.moderation_removed_at IS NULL
          AND (generations.is_public OR generations.showcase_asset_path IS NOT NULL);
      END IF;

      -- An unexposed post that drops its derivative no longer needs the public
      -- copy. Archiving keeps the path, and with it the copy, for restore; a
      -- tombstone keeps both for the buyers.
      IF NOT v_exposed
        AND OLD.showcase_asset_path IS NOT NULL
        AND NEW.showcase_asset_path IS NULL THEN
        v_dropped_path := OLD.showcase_asset_path;
        v_reason := 'post_unexposed';
      END IF;
    END IF;
  END IF;

  IF v_generation_id IS NULL OR v_owner_user_id IS NULL THEN
    -- A post whose creation was deleted serves that creation's copy from the
    -- folder it recorded. There is no generation left to keep in step: only
    -- the copy the post stops needing is queued, under that folder.
    IF v_reason IS NOT NULL AND v_deleted_generation_id IS NOT NULL THEN
      INSERT INTO public.showcase_media_revocations (
        generation_id, post_id, showcase_asset_path, reason
      )
      SELECT v_deleted_generation_id, v_post_id, v_dropped_path, v_reason
      WHERE nullif(btrim(v_dropped_path), '') IS NOT NULL
      ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;
    END IF;
    RETURN NULL;
  END IF;

  -- An operator removal owns the generation's exposure while it stands.
  SELECT generations.showcase_asset_path
  INTO v_generation_path
  FROM public.generations AS generations
  WHERE generations.id = v_generation_id
    AND (
      generations.user_id = v_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = v_owner_user_id
      )
    )
    AND generations.moderation_removed_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A still-exposed post without a path of its own keeps the generation's:
  -- older creation posts only ever recorded the derivative on the generation.
  v_path := CASE WHEN v_exposed THEN coalesce(v_new_path, v_generation_path) END;

  UPDATE public.generations AS generations
  SET is_public = v_is_public,
      showcase_asset_path = v_path
  WHERE generations.id = v_generation_id
    AND (
      generations.user_id = v_owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = generations.user_id
          AND owner.merged_into_user_id = v_owner_user_id
      )
    )
    AND (
      generations.is_public IS DISTINCT FROM v_is_public
      OR generations.showcase_asset_path IS DISTINCT FROM v_path
    );

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.showcase_media_revocations (
      generation_id, post_id, showcase_asset_path, reason
    )
    SELECT DISTINCT v_generation_id, v_post_id, candidates.path, v_reason
    FROM (VALUES (v_dropped_path), (v_generation_path)) AS candidates(path)
    WHERE nullif(btrim(candidates.path), '') IS NOT NULL
    ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.sync_generation_exposure_with_post()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_generation_exposure_with_post()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sync_generation_exposure_with_post() IS
  'Trusted posts trigger: keeps generations.is_public and showcase_asset_path in the post write''s transaction and queues public derivatives the post stopped needing.';

-- 20260920190000's body: a post's creation folder is now its live creation's
-- (made by the account) or the deleted one it recorded, under showcase/ or,
-- for one marked NSFW, private-posts/.
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
      -- A creation's copy, under private-posts/ for one marked NSFW: of a
      -- creation the account made, or of the deleted one the post recorded.
      OR ((starts_with(btrim(paths.path), 'showcase/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/')
          OR starts_with(btrim(paths.path), 'private-posts/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/'))
        AND (p.generation_id IS NULL OR EXISTS (
          SELECT 1 FROM public.generations g WHERE g.id=p.generation_id AND g.user_id=any(v_owner_ids)
        )))
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

-- 20261015013717's body: a private-posts/ folder is also the deleted creation a
-- post recorded, so its owner (and anyone it is shown to) keeps reading it.
create or replace function public.can_read_private_post_media(p_path text,p_viewer_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select starts_with(p_path,'private-posts/') and (
    exists(select 1 from public.posts p join public.profiles owner on owner.id=p.user_id
      where (p.id=split_part(p_path,'/',2)::uuid or p.generation_id=split_part(p_path,'/',2)::uuid
        or p.deleted_generation_id=split_part(p_path,'/',2)::uuid)
      and owner.identity_state not in ('deleting','deleted','merged')
      and (p.showcase_asset_path=p_path or exists(select 1 from public.post_media m where m.post_id=p.id
        and p_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
      and (p.user_id=p_viewer_id or (p.visibility in ('public','unlisted') and p.archived_at is null
        and p.review_status='visible' and p.tombstoned_at is null
        and public.can_read_nsfw_post(p.id,p_viewer_id)
        and not exists(select 1 from public.user_blocks b where
          (b.blocker_user_id=p_viewer_id and b.blocked_user_id=p.user_id)
          or (b.blocker_user_id=p.user_id and b.blocked_user_id=p_viewer_id)))))
    or exists(select 1 from public.post_resource_purchase_media m
      join public.post_resource_bundle_purchases purchase on purchase.id=m.purchase_id
      left join public.post_resource_bundles bundle on bundle.id=purchase.bundle_id
      where purchase.buyer_user_id=p_viewer_id and purchase.moderation_retracted_at is null
        and (bundle.post_id is null or public.can_read_nsfw_post(bundle.post_id,p_viewer_id))
        and p_path=any(array[m.storage_path,m.preview_storage_path,m.rendition_storage_path])))
$$;
revoke all on function public.can_read_private_post_media(text,uuid) from public,anon,authenticated;
grant execute on function public.can_read_private_post_media(text,uuid) to service_role;

-- 20260929120000's body: marking a post NSFW may also move the copy of the
-- deleted creation it recorded.
create or replace function public.commit_nsfw_media_private_copy(p_post_id uuid,p_owner_id uuid,p_public_path text,p_private_path text)
returns void language plpgsql security definer set search_path='' as $$
declare v_post public.posts; v_source_size bigint; v_target_size bigint;
begin
  select * into v_post from public.posts where id=p_post_id and user_id=p_owner_id for update;
  if not found then raise exception 'Post not found'; end if;
  if not starts_with(p_private_path,'private-posts/'||p_post_id::text||'/')
    or not (starts_with(p_public_path,'posts/'||p_post_id::text||'/') or coalesce(starts_with(p_public_path,'showcase/'||coalesce(v_post.generation_id,v_post.deleted_generation_id)::text||'/'),false))
    or not (coalesce(v_post.showcase_asset_path=p_public_path,false) or exists(select 1 from public.post_media m where m.post_id=p_post_id and p_public_path=any(array[m.storage_path,m.preview_storage_path,m.display_storage_path,m.rendition_storage_path,m.teaser_storage_path])))
  then raise exception 'Invalid post media membership'; end if;
  select (metadata->>'size')::bigint into v_source_size from storage.objects where bucket_id='showcase_media' and name=p_public_path;
  select (metadata->>'size')::bigint into v_target_size from storage.objects where bucket_id='post_media' and name=p_private_path;
  if v_source_size is null or v_source_size <= 0 or v_target_size is distinct from v_source_size then raise exception 'Private copy has not been verified'; end if;
  insert into public.uploaded_media_private_copies(public_path,private_path) values(p_public_path,p_private_path)
    on conflict(public_path) do update set revoked_at=null where uploaded_media_private_copies.private_path=excluded.private_path;
  if not found then raise exception 'Conflicting private copy'; end if;
  update public.post_media set
    storage_path=case when storage_path=p_public_path then p_private_path else storage_path end,
    preview_storage_path=case when preview_storage_path=p_public_path then p_private_path else preview_storage_path end,
    display_storage_path=case when display_storage_path=p_public_path then p_private_path else display_storage_path end,
    rendition_storage_path=case when rendition_storage_path=p_public_path then p_private_path else rendition_storage_path end,
    teaser_storage_path=case when teaser_storage_path=p_public_path then p_private_path else teaser_storage_path end
    where post_id=p_post_id;
  update public.posts set showcase_asset_path=p_private_path where id=p_post_id and showcase_asset_path=p_public_path;
end;
$$;
revoke all on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.commit_nsfw_media_private_copy(uuid,uuid,text,text) to service_role;

-- 20260920190000's body: a rendition under the deleted creation's prefix a post
-- recorded is that post's, and gets its teaser like any other. The claim
-- carries that creation's id, so the worker repeats the same check.
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
    select pm.id, coalesce(p.generation_id, p.deleted_generation_id) as generation_id, sz.bytes
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
          coalesce(p.generation_id, p.deleted_generation_id) is not null
          and starts_with(pm.rendition_storage_path, 'showcase/' || coalesce(p.generation_id, p.deleted_generation_id)::text || '/')
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
revoke all on function public.claim_post_media_teaser_repair(text, bigint) from public, anon, authenticated;
grant execute on function public.claim_post_media_teaser_repair(text, bigint) to service_role;

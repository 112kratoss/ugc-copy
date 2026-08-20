-- Make identity admission and account deletion fail closed across linked guest
-- accounts.  The lifecycle lives on profiles because Auth JWTs remain valid
-- until revoked, while a profile transition is transactional with merge/delete.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS identity_state text NOT NULL DEFAULT 'active';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_identity_state_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_identity_state_check
  CHECK (identity_state IN ('active', 'merged', 'deleting'))
  NOT VALID;

UPDATE public.profiles
SET identity_state = CASE
  WHEN merged_into_user_id IS NOT NULL THEN 'merged'
  -- Before this migration the target FK used ON DELETE SET NULL. If a target
  -- was deleted first, merged_at is the only durable evidence that this guest
  -- session was already spent; it must never be resurrected as active.
  WHEN merged_at IS NOT NULL THEN 'deleting'
  ELSE 'active'
END;

-- Jobs may already exist when this additive migration is deployed.  Preserve
-- their linked identities before any retry can remove the profile rows that
-- describe the relationship.
UPDATE public.profiles AS profile
SET identity_state = 'deleting'
FROM public.account_deletion_jobs AS job
WHERE job.status <> 'completed'
  AND (
    profile.id = job.user_id
    OR profile.merged_into_user_id = job.user_id
  );

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_identity_state_shape_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_identity_state_shape_check CHECK (
    identity_state = 'deleting'
    OR (
      identity_state = 'active'
      AND merged_into_user_id IS NULL
      AND merged_at IS NULL
    )
    OR (
      identity_state = 'merged'
      AND merged_into_user_id IS NOT NULL
      AND merged_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_identity_state_check;
ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_identity_state_shape_check;

UPDATE public.account_deletion_jobs AS job
SET storage_manifest = jsonb_set(
  job.storage_manifest,
  '{owner_user_ids}',
  coalesce(
    (
      SELECT jsonb_agg(owner.id::text ORDER BY owner.id::text)
      FROM (
        SELECT job.user_id AS id
        UNION
        SELECT profile.id
        FROM public.profiles AS profile
        WHERE profile.merged_into_user_id = job.user_id
      ) AS owner
    ),
    jsonb_build_array(job.user_id::text)
  ),
  true
)
WHERE NOT (job.storage_manifest ? 'owner_user_ids');

CREATE OR REPLACE FUNCTION public.enforce_profile_identity_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- A merge may only consume an active guest into an active target.  This also
  -- serializes safely with prepare_account_deletion(), which locks and marks the
  -- target before snapshotting its linked identities.
  IF NEW.merged_into_user_id IS DISTINCT FROM OLD.merged_into_user_id
    AND NEW.merged_into_user_id IS NOT NULL THEN
    IF OLD.identity_state <> 'active' THEN
      RAISE EXCEPTION 'Only an active identity may be merged'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles AS target
      WHERE target.id = NEW.merged_into_user_id
        AND target.identity_state = 'active'
    ) THEN
      RAISE EXCEPTION 'Merge target is not active'
        USING ERRCODE = '23514';
    END IF;

    NEW.identity_state := 'merged';
  END IF;

  -- The compatibility release still has ON DELETE SET NULL. If the previously
  -- deployed deletion worker removes a target first, convert the detached guest
  -- to deleting in the same row update instead of either reactivating it or
  -- failing the old flow. An AFTER trigger below snapshots that guest into its
  -- own durable cleanup job. Stage 3 replaces SET NULL with RESTRICT.
  IF OLD.merged_into_user_id IS NOT NULL
    AND NEW.merged_into_user_id IS NULL THEN
    NEW.identity_state := 'deleting';
  END IF;

  IF OLD.identity_state = 'deleting' AND NEW.identity_state <> 'deleting' THEN
    RAISE EXCEPTION 'A deleting identity cannot be reactivated'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.identity_state = 'merged' AND NEW.merged_into_user_id IS NULL THEN
    RAISE EXCEPTION 'A merged identity requires a target'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_enforce_identity_state_transition
  ON public.profiles;
CREATE TRIGGER profiles_enforce_identity_state_transition
BEFORE UPDATE OF identity_state, merged_into_user_id ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_profile_identity_state_transition();

REVOKE ALL ON FUNCTION public.enforce_profile_identity_state_transition()
  FROM PUBLIC, anon, authenticated;

-- The request guard and RLS call zero-argument helpers, so a caller cannot ask
-- about another UUID. SECURITY DEFINER avoids recursive profiles RLS evaluation.
CREATE OR REPLACE FUNCTION public.current_identity_state()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT identity_state
  FROM public.profiles
  WHERE id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION public.current_identity_state()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_state()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_identity_is_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND identity_state = 'active'
  );
$$;

REVOKE ALL ON FUNCTION public.current_identity_is_active()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_identity_is_active()
  TO authenticated, service_role;

-- Any public table with a relation- or column-level authenticated Data API DML
-- grant gets the same restrictive lifecycle gate. Existing permissive owner
-- policies still decide which rows are visible; this policy only removes every
-- path once the caller is merged or deleting.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    WITH authenticated_tables AS (
      SELECT DISTINCT relation.oid, namespace.nspname, relation.relname
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND grantee.rolname = 'authenticated'
        AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')

      UNION

      SELECT DISTINCT relation.oid, namespace.nspname, relation.relname
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
      CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
      JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND grantee.rolname = 'authenticated'
        AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    )
    SELECT * FROM authenticated_tables ORDER BY nspname, relname
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      target.nspname,
      target.relname
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS authenticated_identity_active ON %I.%I',
      target.nspname,
      target.relname
    );
    EXECUTE format(
      'CREATE POLICY authenticated_identity_active ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.current_identity_is_active())) WITH CHECK ((SELECT public.current_identity_is_active()))',
      target.nspname,
      target.relname
    );
  END LOOP;
END;
$$;

-- Storage lives outside public, so it is not discovered by the grant loop
-- above. Its owner-prefix policies would otherwise continue to authorize a
-- stale guest JWT after that profile has been merged or marked for deletion.
DROP POLICY IF EXISTS authenticated_identity_active ON storage.objects;
CREATE POLICY authenticated_identity_active
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_active()))
  WITH CHECK ((SELECT public.current_identity_is_active()));

-- Authenticated callers can be granted bucket discovery by the Storage
-- service. Apply the same lifecycle boundary so bucket metadata cannot become
-- a second direct-Storage path for a spent identity.
DROP POLICY IF EXISTS authenticated_identity_active ON storage.buckets;
CREATE POLICY authenticated_identity_active
  ON storage.buckets
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.current_identity_is_active()))
  WITH CHECK ((SELECT public.current_identity_is_active()));

-- Snapshot the target and every linked guest in one durable manifest.  A retry
-- reuses the persisted manifest rather than recomputing it after a partial Auth
-- cascade has removed ownership rows.
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

  SELECT coalesce(jsonb_agg(path ORDER BY path), '[]'::jsonb)
  INTO v_showcase_paths
  FROM (
    SELECT DISTINCT generation.showcase_asset_path AS path
    FROM public.generations AS generation
    WHERE generation.user_id = ANY(v_owner_ids)
      AND btrim(coalesce(generation.showcase_asset_path, '')) <> ''
      AND btrim(generation.showcase_asset_path)
        LIKE 'showcase/' || generation.id::text || '/%'
    UNION
    SELECT DISTINCT post.showcase_asset_path AS path
    FROM public.posts AS post
    WHERE post.user_id = ANY(v_owner_ids)
      AND btrim(coalesce(post.showcase_asset_path, '')) <> ''
      AND (
        btrim(post.showcase_asset_path) LIKE 'posts/' || post.id::text || '/%'
        OR (
          post.generation_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.generations AS owned_generation
            WHERE owned_generation.id = post.generation_id
              AND owned_generation.user_id = ANY(v_owner_ids)
          )
          AND btrim(post.showcase_asset_path)
            LIKE 'showcase/' || post.generation_id::text || '/%'
        )
      )
    UNION
    SELECT DISTINCT media.storage_path AS path
    FROM public.post_media AS media
    JOIN public.posts AS post ON post.id = media.post_id
    WHERE post.user_id = ANY(v_owner_ids)
      AND btrim(coalesce(media.storage_path, '')) <> ''
      AND btrim(media.storage_path) LIKE 'posts/' || post.id::text || '/%'
    UNION
    SELECT DISTINCT media.preview_storage_path AS path
    FROM public.post_media AS media
    JOIN public.posts AS post ON post.id = media.post_id
    WHERE post.user_id = ANY(v_owner_ids)
      AND btrim(coalesce(media.preview_storage_path, '')) <> ''
      AND btrim(media.preview_storage_path) LIKE 'posts/' || post.id::text || '/%'
  ) AS owned_showcase_paths;

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

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid)
  TO service_role;

-- Preserve zero-downtime compatibility with the previously deployed
-- target-first worker while still failing closed. The FK's SET NULL action
-- invokes the BEFORE trigger above, which marks the detached guest deleting;
-- this AFTER trigger then gives that guest an independent retryable manifest.
-- Once the deferred stage-3 RESTRICT constraint is promoted this remains a
-- harmless defense for explicit service-role pointer changes.
CREATE OR REPLACE FUNCTION public.enqueue_detached_merged_identity_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.merged_into_user_id IS NOT NULL
    AND NEW.merged_into_user_id IS NULL
    AND NEW.identity_state = 'deleting' THEN
    PERFORM public.prepare_account_deletion(NEW.id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_enqueue_detached_merged_identity_deletion
  ON public.profiles;
CREATE TRIGGER profiles_enqueue_detached_merged_identity_deletion
AFTER UPDATE OF merged_into_user_id ON public.profiles
FOR EACH ROW
WHEN (
  OLD.merged_into_user_id IS NOT NULL
  AND NEW.merged_into_user_id IS NULL
)
EXECUTE FUNCTION public.enqueue_detached_merged_identity_deletion();

REVOKE ALL ON FUNCTION public.enqueue_detached_merged_identity_deletion()
  FROM PUBLIC, anon, authenticated;

-- Finish cleanup for a historical target-first delete. Those rows have no
-- target left to own their data, so each orphan guest becomes an independent,
-- durable deletion job whose manifest retains its own Auth/storage UUID.
DO $$
DECLARE
  orphan record;
BEGIN
  FOR orphan IN
    SELECT profile.id
    FROM public.profiles AS profile
    LEFT JOIN public.account_deletion_jobs AS job ON job.user_id = profile.id
    WHERE profile.merged_at IS NOT NULL
      AND profile.merged_into_user_id IS NULL
      AND profile.identity_state = 'deleting'
      AND job.user_id IS NULL
    ORDER BY profile.id
  LOOP
    PERFORM public.prepare_account_deletion(orphan.id);
  END LOOP;
END;
$$;

-- Keep the existing ON DELETE SET NULL relationship during the application
-- cutover. The deferred stage-3 contract migration changes it to RESTRICT only
-- after telemetry confirms every deletion worker is guest-first.

COMMENT ON COLUMN public.profiles.identity_state IS
  'Durable admission state. Only active identities may use authenticated application or Data API paths.';
COMMENT ON FUNCTION public.current_identity_is_active() IS
  'RLS lifecycle gate for the current JWT subject; missing, merged, and deleting profiles fail closed.';
COMMENT ON FUNCTION public.current_identity_state() IS
  'Returns only the current JWT subject lifecycle state for centralized route admission.';
COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS
  'Atomically marks and snapshots a target plus all linked guest identities for retryable guest-first deletion.';

-- Persist account deletion progress independently of auth.users so cleanup is
-- observable and retryable even if the auth row is removed on the final step.

CREATE TABLE IF NOT EXISTS public.account_deletion_jobs (
  user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN (
      'requested',
      'storage_deleting',
      'storage_deleted',
      'auth_deleting',
      'completed',
      'failed'
    )),
  storage_manifest jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(storage_manifest) = 'object'),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_attempt_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  storage_completed_at timestamptz,
  auth_delete_started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS account_deletion_jobs_status_updated_idx
  ON public.account_deletion_jobs (status, updated_at)
  WHERE status <> 'completed';

ALTER TABLE public.account_deletion_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_jobs FROM PUBLIC;
REVOKE ALL ON public.account_deletion_jobs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.account_deletion_jobs TO service_role;

DROP POLICY IF EXISTS "No client access to account_deletion_jobs"
  ON public.account_deletion_jobs;
CREATE POLICY "No client access to account_deletion_jobs"
  ON public.account_deletion_jobs FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_showcase_paths jsonb;
  v_template_prefixes jsonb;
  v_manifest jsonb;
  v_job public.account_deletion_jobs%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_user_id::text, 0));

  SELECT coalesce(jsonb_agg(path ORDER BY path), '[]'::jsonb)
  INTO v_showcase_paths
  FROM (
    SELECT DISTINCT btrim(showcase_asset_path) AS path
    FROM public.generations
    WHERE user_id = p_user_id
      AND btrim(coalesce(showcase_asset_path, '')) <> ''
      AND btrim(showcase_asset_path) LIKE 'showcase/' || id::text || '/%'
    UNION
    SELECT DISTINCT btrim(showcase_asset_path) AS path
    FROM public.posts
    WHERE user_id = p_user_id
      AND btrim(coalesce(showcase_asset_path, '')) <> ''
      AND (
        btrim(showcase_asset_path) LIKE 'posts/' || id::text || '/%'
        OR (
          generation_id IS NOT NULL
          AND btrim(showcase_asset_path) LIKE 'showcase/' || generation_id::text || '/%'
        )
      )
    UNION
    SELECT DISTINCT btrim(post_media.storage_path) AS path
    FROM public.post_media post_media
    JOIN public.posts posts ON posts.id = post_media.post_id
    WHERE posts.user_id = p_user_id
      AND btrim(coalesce(post_media.storage_path, '')) <> ''
      AND btrim(post_media.storage_path) LIKE 'posts/' || posts.id::text || '/%'
    UNION
    SELECT DISTINCT btrim(post_media.preview_storage_path) AS path
    FROM public.post_media post_media
    JOIN public.posts posts ON posts.id = post_media.post_id
    WHERE posts.user_id = p_user_id
      AND btrim(coalesce(post_media.preview_storage_path, '')) <> ''
      AND btrim(post_media.preview_storage_path) LIKE 'posts/' || posts.id::text || '/%'
  ) owned_showcase_paths;

  SELECT coalesce(jsonb_agg(id::text ORDER BY id::text), '[]'::jsonb)
  INTO v_template_prefixes
  FROM public.templates
  WHERE creator_user_id = p_user_id;

  v_manifest := jsonb_build_object(
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
  )
  VALUES (
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
  SET status = CASE
        WHEN account_deletion_jobs.status = 'completed' THEN 'completed'
        ELSE 'requested'
      END,
      storage_manifest = EXCLUDED.storage_manifest,
      attempt_count = account_deletion_jobs.attempt_count + 1,
      last_error = NULL,
      last_attempt_at = timezone('utc'::text, now()),
      updated_at = timezone('utc'::text, now())
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_job.status = 'completed' THEN 'already_completed' ELSE 'prepared' END,
    'user_id', v_job.user_id,
    'attempt_count', v_job.attempt_count,
    'storage_manifest', v_job.storage_manifest
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_account_deletion_stage(
  p_user_id uuid,
  p_status text,
  p_error_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job public.account_deletion_jobs%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_status NOT IN (
    'storage_deleting',
    'storage_deleted',
    'auth_deleting',
    'completed',
    'failed'
  ) THEN
    RETURN jsonb_build_object('status', 'invalid_request');
  END IF;

  SELECT *
  INTO v_job
  FROM public.account_deletion_jobs
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed', 'user_id', p_user_id);
  END IF;

  UPDATE public.account_deletion_jobs
  SET status = p_status,
      storage_manifest = CASE
        WHEN p_status = 'completed' THEN jsonb_build_object(
          'retention_policy', storage_manifest->'retention_policy'
        )
        ELSE storage_manifest
      END,
      last_error = CASE
        WHEN p_status = 'failed' THEN left(coalesce(p_error_message, 'Unknown deletion error'), 1000)
        ELSE NULL
      END,
      storage_completed_at = CASE
        WHEN p_status = 'storage_deleted' THEN coalesce(storage_completed_at, timezone('utc'::text, now()))
        ELSE storage_completed_at
      END,
      auth_delete_started_at = CASE
        WHEN p_status = 'auth_deleting' THEN coalesce(auth_delete_started_at, timezone('utc'::text, now()))
        ELSE auth_delete_started_at
      END,
      completed_at = CASE
        WHEN p_status = 'completed' THEN coalesce(completed_at, timezone('utc'::text, now()))
        ELSE completed_at
      END,
      updated_at = timezone('utc'::text, now())
  WHERE user_id = p_user_id
  RETURNING * INTO v_job;

  RETURN jsonb_build_object(
    'status', v_job.status,
    'user_id', v_job.user_id,
    'attempt_count', v_job.attempt_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_account_deletion_job_after_auth_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.account_deletion_jobs
  SET status = 'completed',
      storage_manifest = jsonb_build_object(
        'retention_policy', storage_manifest->'retention_policy'
      ),
      last_error = NULL,
      completed_at = coalesce(completed_at, timezone('utc'::text, now())),
      updated_at = timezone('utc'::text, now())
  WHERE user_id = OLD.id
    AND status = 'auth_deleting';

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS account_deletion_job_after_auth_delete ON auth.users;
CREATE TRIGGER account_deletion_job_after_auth_delete
AFTER DELETE ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.complete_account_deletion_job_after_auth_delete();

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.mark_account_deletion_stage(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_account_deletion_stage(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.mark_account_deletion_stage(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_account_deletion_stage(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.complete_account_deletion_job_after_auth_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_account_deletion_job_after_auth_delete() FROM anon;
REVOKE ALL ON FUNCTION public.complete_account_deletion_job_after_auth_delete() FROM authenticated;

COMMENT ON TABLE public.account_deletion_jobs
  IS 'Durable account deletion progress and storage manifest. Intentionally has no auth.users FK so completion evidence survives auth deletion.';
COMMENT ON FUNCTION public.prepare_account_deletion(uuid)
  IS 'Captures user-owned private, showcase, and template storage before auth cascades remove ownership rows.';

-- Complete the additive upload-capability cutover. 071000 introduced trusted
-- reservation metadata; this migration makes issuance, replay revocation,
-- consumption, account deletion, and reclamation one database-enforced state
-- machine while retaining conservative wrappers for rolling server instances.

DROP TRIGGER IF EXISTS upload_byte_reservations_enforce_lifecycle
  ON public.upload_byte_reservations;
DROP FUNCTION IF EXISTS public.enforce_upload_byte_reservation_lifecycle();

ALTER TABLE public.upload_byte_reservations
  DROP CONSTRAINT IF EXISTS upload_byte_reservations_finalization_status_check,
  DROP CONSTRAINT IF EXISTS upload_byte_reservations_safe_release_check,
  DROP CONSTRAINT IF EXISTS upload_byte_reservations_reclaim_quiescence_check;

ALTER TABLE public.upload_byte_reservations
  ADD COLUMN IF NOT EXISTS issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumption_lease_id uuid,
  ADD COLUMN IF NOT EXISTS consumption_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_consumption_lease_id uuid,
  ADD COLUMN IF NOT EXISTS consumption_outcome_unknown_at timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_compatibility_mode boolean;

-- Every row that predates this migration was created by the path-only v1
-- protocol (including rows backfilled by 071000). Keep that provenance as a
-- first-class bit; content type is attacker-influenced and is not a safe proxy.
UPDATE public.upload_byte_reservations
SET legacy_compatibility_mode = true,
    issued_at = coalesce(issued_at, created_at),
    expires_at = greatest(expires_at, now()),
    finalization_status = CASE
      WHEN actual_storage_id IS NOT NULL
       AND actual_storage_version IS NOT NULL
       AND actual_bytes IS NOT NULL
       AND actual_content_type IS NOT NULL
       AND finalization_status IN ('finalized', 'consumed')
        THEN finalization_status
      ELSE 'issued'
    END,
    released_at = NULL,
    status_updated_at = now()
WHERE legacy_compatibility_mode IS NULL;

ALTER TABLE public.upload_byte_reservations
  ALTER COLUMN legacy_compatibility_mode SET DEFAULT false,
  ALTER COLUMN legacy_compatibility_mode SET NOT NULL,
  ALTER COLUMN finalization_status SET DEFAULT 'reserved';

CREATE TABLE IF NOT EXISTS public.upload_path_tombstones (
  bucket_id text NOT NULL CHECK (btrim(bucket_id) <> ''),
  storage_path text NOT NULL CHECK (btrim(storage_path) <> ''),
  upload_id uuid,
  owner_user_id uuid,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_id, storage_path)
);

CREATE TABLE IF NOT EXISTS public.blocked_upload_owners (
  owner_user_id uuid PRIMARY KEY,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'account_deletion' CHECK (btrim(reason) <> '')
);

ALTER TABLE public.upload_path_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_upload_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.upload_path_tombstones FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.blocked_upload_owners FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.upload_path_tombstones TO service_role;
GRANT SELECT ON public.blocked_upload_owners TO service_role;

CREATE OR REPLACE FUNCTION public.lock_upload_storage_path(
  p_bucket_id text,
  p_storage_path text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'upload-path:' || length(coalesce(p_bucket_id, ''))::text || ':'
      || coalesce(p_bucket_id, '') || ':' || coalesce(p_storage_path, ''),
    0
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_upload_owner(p_owner_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'upload-owner:' || coalesce(p_owner_user_id::text, ''),
    0
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.tombstone_upload_path(
  p_bucket_id text,
  p_storage_path text,
  p_upload_id uuid,
  p_owner_user_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.lock_upload_storage_path(p_bucket_id, p_storage_path);
  INSERT INTO public.upload_path_tombstones (
    bucket_id, storage_path, upload_id, owner_user_id, reason
  ) VALUES (
    btrim(p_bucket_id), btrim(p_storage_path), p_upload_id,
    p_owner_user_id, coalesce(nullif(btrim(p_reason), ''), 'revoked')
  )
  ON CONFLICT (bucket_id, storage_path) DO NOTHING;
END;
$$;

-- Old released rows were conservatively re-opened above and remain charged.
-- Do not tombstone every pre-v2 row here: outstanding legacy mobile tokens
-- must remain usable through the compatibility window. Their first explicit
-- finalization/release/reclaim transition creates the permanent tombstone.

CREATE OR REPLACE FUNCTION public.enforce_upload_byte_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tombstone_reason text;
BEGIN
  PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.storage_path);

  IF ROW(
    NEW.id, NEW.user_id, NEW.bucket_id, NEW.storage_path,
    NEW.declared_bytes, NEW.reserved_bytes, NEW.expected_content_type,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.user_id, OLD.bucket_id, OLD.storage_path,
    OLD.declared_bytes, OLD.reserved_bytes, OLD.expected_content_type,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Upload reservation identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.legacy_compatibility_mode IS DISTINCT FROM OLD.legacy_compatibility_mode
    AND NOT (
      OLD.finalization_status = 'reserved'
      AND OLD.issued_at IS NULL
      AND OLD.legacy_compatibility_mode = false
      AND NEW.legacy_compatibility_mode = true
    ) THEN
    RAISE EXCEPTION 'Upload compatibility provenance is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.expires_at IS DISTINCT FROM OLD.expires_at
    AND NOT (
      OLD.finalization_status = 'reserved'
      AND NEW.finalization_status = 'issued'
      AND OLD.issued_at IS NULL
      AND NEW.issued_at IS NOT NULL
      AND NEW.expires_at > now()
    ) THEN
    RAISE EXCEPTION 'Upload capability expiry can only be anchored at issuance'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'Upload issuance time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_bytes IS NOT NULL AND NEW.actual_bytes IS DISTINCT FROM OLD.actual_bytes THEN
    RAISE EXCEPTION 'Finalized upload byte metadata is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_content_type IS NOT NULL
    AND NEW.actual_content_type IS DISTINCT FROM OLD.actual_content_type THEN
    RAISE EXCEPTION 'Finalized upload content metadata is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_storage_id IS NOT NULL
    AND NEW.actual_storage_id IS DISTINCT FROM OLD.actual_storage_id THEN
    RAISE EXCEPTION 'Finalized Storage object identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_storage_version IS NOT NULL
    AND NEW.actual_storage_version IS DISTINCT FROM OLD.actual_storage_version THEN
    RAISE EXCEPTION 'Finalized Storage object version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'Upload finalization time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.client_finalized_at IS NOT NULL
    AND NEW.client_finalized_at IS DISTINCT FROM OLD.client_finalized_at THEN
    RAISE EXCEPTION 'Client finalization time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'Upload consumption time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumption_disposition IS NOT NULL
    AND NEW.consumption_disposition IS DISTINCT FROM OLD.consumption_disposition
    AND NOT (
      OLD.finalization_status = 'consuming'
      AND NEW.finalization_status = 'finalized'
      AND OLD.consumed_at IS NULL
      AND NEW.consumption_disposition IS NULL
    ) THEN
    RAISE EXCEPTION 'Upload consumption disposition is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.consumption_outcome_unknown_at IS NOT NULL
    AND NEW.consumption_outcome_unknown_at IS NULL
    AND NOT (
      OLD.finalization_status = 'consuming'
      AND NEW.finalization_status = 'consumed'
      AND NEW.last_consumption_lease_id IS NOT NULL
      AND NEW.last_consumption_lease_id IS DISTINCT FROM OLD.last_consumption_lease_id
    ) THEN
    RAISE EXCEPTION 'An uncertain consumption outcome requires exact lease completion'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.finalization_status = 'consuming'
    AND NEW.finalization_status = 'consuming'
    AND ROW(NEW.consumption_lease_id, NEW.consumption_lease_expires_at)
      IS DISTINCT FROM ROW(OLD.consumption_lease_id, OLD.consumption_lease_expires_at) THEN
    RAISE EXCEPTION 'An active consumption lease is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status IS DISTINCT FROM OLD.finalization_status
    AND NOT (
      (OLD.finalization_status = 'reserved'
        AND NEW.finalization_status IN ('issued', 'deleted', 'released'))
      OR (OLD.finalization_status = 'issued'
        AND NEW.finalization_status IN ('finalizing', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'finalizing'
        AND NEW.finalization_status IN ('issued', 'finalized', 'consumed', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'finalized'
        AND NEW.finalization_status IN ('finalizing', 'consuming', 'consumed', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'consuming'
        AND NEW.finalization_status IN ('finalized', 'consumed', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'consumed'
        AND NEW.finalization_status IN ('finalizing', 'consuming', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'deleted'
        AND NEW.finalization_status = 'reclaiming')
      OR (OLD.finalization_status = 'reclaiming'
        AND NEW.finalization_status IN ('reclaiming', 'consumed', 'deleted'))
    ) THEN
    RAISE EXCEPTION 'Invalid upload reservation lifecycle transition: % -> %',
      OLD.finalization_status, NEW.finalization_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status IN ('finalized', 'consuming', 'consumed')
    AND (
      NEW.actual_bytes IS NULL OR NEW.actual_content_type IS NULL
      OR NEW.actual_storage_id IS NULL OR NEW.actual_storage_version IS NULL
      OR NEW.finalized_at IS NULL
    ) THEN
    RAISE EXCEPTION 'Finalized uploads require trusted versioned Storage metadata'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status = 'consuming' AND (
    NEW.consumption_lease_id IS NULL
    OR NEW.consumption_lease_expires_at IS NULL
    OR NEW.consumption_lease_expires_at <= now()
    OR NEW.consumption_disposition IS NULL
  ) THEN
    RAISE EXCEPTION 'Consuming uploads require an active lease and disposition'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.finalization_status <> 'consuming'
    AND (NEW.consumption_lease_id IS NOT NULL OR NEW.consumption_lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only consuming uploads may retain a lease'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.finalization_status = 'consumed'
    AND (NEW.consumed_at IS NULL OR NEW.consumption_disposition IS NULL) THEN
    RAISE EXCEPTION 'Consumed uploads require a durable disposition'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.reclaim_not_before IS NULL AND NEW.reclaim_not_before IS NOT NULL THEN
    IF OLD.expires_at > now()
      OR NEW.finalization_status <> 'reclaiming'
      OR NEW.released_at IS NOT NULL
      OR NEW.reclaim_not_before < now() + interval '10 minutes' THEN
      RAISE EXCEPTION 'First reclaim must follow expiry and retain quiescence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.reclaim_not_before IS NOT NULL
    AND NEW.reclaim_not_before IS DISTINCT FROM OLD.reclaim_not_before THEN
    IF NOT (
      OLD.finalization_status = 'consumed'
      AND NEW.finalization_status = 'reclaiming'
      AND NEW.reclaim_not_before >= now() + interval '10 minutes'
      AND NEW.released_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Reclaim quiescence is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'Upload release time is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    IF NOT (
      (OLD.finalization_status = 'reserved'
        AND NEW.finalization_status = 'released'
        AND OLD.issued_at IS NULL)
      OR (
        OLD.finalization_status = 'reclaiming'
        AND OLD.reclaim_not_before IS NOT NULL
        AND OLD.reclaim_not_before <= now()
        AND EXISTS (
          SELECT 1 FROM public.upload_path_tombstones AS tombstone
          WHERE tombstone.bucket_id = OLD.bucket_id
            AND tombstone.storage_path = OLD.storage_path
        )
      )
    ) THEN
      RAISE EXCEPTION 'Upload capacity release requires pre-issue abort or stale reclaim proof'
        USING ERRCODE = '23514';
    END IF;

    -- The application worker performs the Storage check, but release is a
    -- security boundary and must fail closed even if a future service-role
    -- caller attempts a direct lifecycle update. Deleted/revoked staging
    -- objects must be absent; a preserved durable object must still be the
    -- exact immutable Storage version that was finalized. Drafts are never
    -- releasable while present.
    IF OLD.finalization_status = 'reclaiming' THEN
      IF NEW.finalization_status = 'deleted' AND EXISTS (
        SELECT 1
        FROM storage.objects AS object
        WHERE object.bucket_id = OLD.bucket_id
          AND object.name = OLD.storage_path
      ) THEN
        RAISE EXCEPTION 'Deleted upload capacity cannot be released while Storage still contains the object'
          USING ERRCODE = '23514';
      ELSIF NEW.finalization_status = 'consumed' AND NOT (
        NEW.consumption_disposition = 'preserve'
        AND NEW.actual_storage_id IS NOT NULL
        AND NEW.actual_storage_version IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM storage.objects AS object
          WHERE object.bucket_id = OLD.bucket_id
            AND object.name = OLD.storage_path
            AND object.id = NEW.actual_storage_id
            AND object.version IS NOT DISTINCT FROM NEW.actual_storage_version
        )
      ) THEN
        RAISE EXCEPTION 'Preserved upload capacity requires the exact finalized Storage object'
          USING ERRCODE = '23514';
      ELSIF NEW.finalization_status NOT IN ('deleted', 'consumed') THEN
        RAISE EXCEPTION 'Stale reclaim release requires a deleted or preserved terminal state'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.finalization_status IN ('finalizing', 'finalized', 'consuming', 'consumed', 'deleted', 'reclaiming') THEN
    v_tombstone_reason := 'lifecycle_' || NEW.finalization_status;
    PERFORM public.tombstone_upload_path(
      NEW.bucket_id, NEW.storage_path, NEW.id, NEW.user_id, v_tombstone_reason
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER upload_byte_reservations_enforce_lifecycle
BEFORE UPDATE ON public.upload_byte_reservations
FOR EACH ROW EXECUTE FUNCTION public.enforce_upload_byte_reservation_lifecycle();

CREATE OR REPLACE FUNCTION public.guard_upload_storage_object_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_key text;
  v_new_key text;
  v_old_owner text;
  v_new_owner text;
BEGIN
  v_new_owner := split_part(NEW.name, '/', 1);
  v_old_owner := CASE WHEN TG_OP = 'UPDATE'
    THEN split_part(OLD.name, '/', 1) ELSE v_new_owner END;

  -- Account deletion takes owner then path locks. Storage must use the same
  -- order so even a service-created object with no reservation cannot commit
  -- after the deletion sweep has proven the prefix empty.
  IF v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND v_old_owner <> v_new_owner THEN
    IF v_old_owner < v_new_owner THEN
      PERFORM public.lock_upload_owner(v_old_owner::uuid);
      PERFORM public.lock_upload_owner(v_new_owner::uuid);
    ELSE
      PERFORM public.lock_upload_owner(v_new_owner::uuid);
      PERFORM public.lock_upload_owner(v_old_owner::uuid);
    END IF;
  ELSIF v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.lock_upload_owner(v_new_owner::uuid);
  ELSIF v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM public.lock_upload_owner(v_old_owner::uuid);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_key := OLD.bucket_id || '/' || OLD.name;
    v_new_key := NEW.bucket_id || '/' || NEW.name;
    IF v_old_key <= v_new_key THEN
      PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.name);
      IF v_new_key <> v_old_key THEN
        PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
      END IF;
    ELSE
      PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
      PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.name);
    END IF;
  ELSE
    PERFORM public.lock_upload_storage_path(NEW.bucket_id, NEW.name);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.upload_path_tombstones AS tombstone
    WHERE (tombstone.bucket_id, tombstone.storage_path)
      IN ((NEW.bucket_id, NEW.name),
          (CASE WHEN TG_OP = 'UPDATE' THEN OLD.bucket_id ELSE NEW.bucket_id END,
           CASE WHEN TG_OP = 'UPDATE' THEN OLD.name ELSE NEW.name END))
  ) THEN
    RAISE EXCEPTION 'Upload path has been permanently revoked'
      USING ERRCODE = '42501';
  END IF;

  IF (
    NEW.bucket_id IN (
      'profiles', 'uploads', 'generated_images', 'generated_videos',
      'generated_audio', 'generation_inputs', 'post_resource_files',
      'template_inputs'
    ) AND EXISTS (
      SELECT 1 FROM public.blocked_upload_owners AS blocked
      WHERE v_new_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND blocked.owner_user_id = v_new_owner::uuid
    )
  ) OR (
    TG_OP = 'UPDATE'
    AND OLD.bucket_id IN (
      'profiles', 'uploads', 'generated_images', 'generated_videos',
      'generated_audio', 'generation_inputs', 'post_resource_files',
      'template_inputs'
    ) AND EXISTS (
      SELECT 1 FROM public.blocked_upload_owners AS blocked
      WHERE v_old_owner ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND blocked.owner_user_id = v_old_owner::uuid
    )
  ) THEN
    RAISE EXCEPTION 'Upload owner has been permanently blocked'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_upload_storage_object_write ON storage.objects;
CREATE TRIGGER guard_upload_storage_object_write
BEFORE INSERT OR UPDATE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION public.guard_upload_storage_object_write();

CREATE OR REPLACE FUNCTION public.guard_upload_reservation_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.lock_upload_storage_path(OLD.bucket_id, OLD.storage_path);
  IF OLD.released_at IS NULL THEN
    RAISE EXCEPTION 'Unreleased upload reservations cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.issued_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.upload_path_tombstones AS tombstone
    WHERE tombstone.bucket_id = OLD.bucket_id
      AND tombstone.storage_path = OLD.storage_path
  ) THEN
    RAISE EXCEPTION 'Issued upload reservations require a permanent tombstone before deletion'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS upload_byte_reservations_guard_delete
  ON public.upload_byte_reservations;
CREATE TRIGGER upload_byte_reservations_guard_delete
BEFORE DELETE ON public.upload_byte_reservations
FOR EACH ROW EXECUTE FUNCTION public.guard_upload_reservation_delete();

ALTER TABLE public.upload_byte_reservations
  ADD CONSTRAINT upload_byte_reservations_finalization_status_check
    CHECK (finalization_status IN (
      'reserved', 'issued', 'finalizing', 'finalized', 'consuming',
      'consumed', 'reclaiming', 'deleted', 'released'
    )),
  ADD CONSTRAINT upload_byte_reservations_lease_pair_check
    CHECK ((consumption_lease_id IS NULL) = (consumption_lease_expires_at IS NULL)),
  ADD CONSTRAINT upload_byte_reservations_issued_pair_check
    CHECK (
      (finalization_status = 'reserved' AND issued_at IS NULL)
      OR finalization_status <> 'reserved'
    );

DROP INDEX IF EXISTS public.upload_byte_reservations_active_user_idx;
DROP INDEX IF EXISTS public.upload_byte_reservations_active_global_idx;
DROP INDEX IF EXISTS public.upload_byte_reservations_expired_reclaimable_idx;
CREATE INDEX upload_byte_reservations_active_user_idx
  ON public.upload_byte_reservations (user_id, id)
  INCLUDE (reserved_bytes, actual_bytes, finalization_status, released_at)
  WHERE released_at IS NULL;
CREATE INDEX upload_byte_reservations_active_global_idx
  ON public.upload_byte_reservations (id)
  INCLUDE (reserved_bytes, actual_bytes, finalization_status, released_at)
  WHERE released_at IS NULL;
CREATE INDEX upload_byte_reservations_expired_reclaimable_idx
  ON public.upload_byte_reservations (id)
  WHERE released_at IS NULL
    AND finalization_status IN (
      'reserved', 'issued', 'finalizing', 'finalized', 'consuming',
      'consumed', 'deleted', 'reclaiming'
    );

REVOKE INSERT, DELETE ON public.upload_byte_reservations FROM service_role;
GRANT SELECT, UPDATE ON public.upload_byte_reservations TO service_role;

REVOKE ALL ON FUNCTION public.lock_upload_storage_path(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lock_upload_owner(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tombstone_upload_path(text, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_upload_byte_reservation_lifecycle()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_upload_storage_object_write()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_upload_reservation_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.upload_surface_max_bytes(p_bucket_id text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE btrim(coalesce(p_bucket_id, ''))
    WHEN 'profiles' THEN 5 * 1024 * 1024
    WHEN 'generated_images' THEN 25 * 1024 * 1024
    WHEN 'generated_videos' THEN 250 * 1024 * 1024
    WHEN 'generated_audio' THEN 50 * 1024 * 1024
    WHEN 'post_resource_files' THEN 50 * 1024 * 1024
    WHEN 'template_inputs' THEN 100 * 1024 * 1024
    WHEN 'uploads' THEN 250 * 1024 * 1024
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.is_upload_owner_active(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state text;
BEGIN
  IF p_user_id IS NULL
    OR public.is_account_deletion_requested(p_user_id)
    OR EXISTS (
      SELECT 1 FROM public.blocked_upload_owners AS blocked
      WHERE blocked.owner_user_id = p_user_id
    ) THEN
    RETURN false;
  END IF;

  SELECT coalesce(
    to_jsonb(profile) ->> 'identity_state',
    CASE WHEN profile.merged_into_user_id IS NULL THEN 'active' ELSE 'merged' END
  )
  INTO v_state
  FROM public.profiles AS profile
  WHERE profile.id = p_user_id;

  RETURN coalesce(v_state = 'active', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_upload_bytes_v2(
  p_upload_id uuid,
  p_user_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_declared_bytes bigint,
  p_reserved_bytes bigint,
  p_expected_content_type text,
  p_user_limit_bytes bigint,
  p_global_limit_bytes bigint,
  p_ttl_seconds integer DEFAULT 7200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bucket text := btrim(coalesce(p_bucket_id, ''));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_expected_type text := lower(btrim(coalesce(p_expected_content_type, '')));
  v_declared bigint := greatest(coalesce(p_declared_bytes, 0), 0);
  v_reserved bigint := greatest(coalesce(p_reserved_bytes, 0), 0);
  v_surface_max bigint := public.upload_surface_max_bytes(p_bucket_id);
  v_user_limit bigint := greatest(coalesce(p_user_limit_bytes, 0), 1);
  v_global_limit bigint := greatest(coalesce(p_global_limit_bytes, 0), 1);
  v_ttl integer := greatest(60, least(coalesce(p_ttl_seconds, 7200), 86400));
  v_user_outstanding bigint;
  v_global_outstanding bigint;
  v_existing public.upload_byte_reservations%ROWTYPE;
BEGIN
  IF p_upload_id IS NULL OR p_user_id IS NULL OR v_bucket = '' OR v_path = ''
    OR v_declared <= 0 OR v_expected_type = '' OR v_surface_max IS NULL
    OR v_reserved < v_declared OR v_reserved < v_surface_max
    OR split_part(v_path, '/', 1) <> p_user_id::text THEN
    RAISE EXCEPTION 'A canonical owner path and full surface byte reservation are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.lock_upload_owner(p_user_id);
  IF NOT public.is_upload_owner_active(p_user_id) THEN
    RAISE EXCEPTION 'Upload owner is not active' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upload-byte-admission', 0));
  PERFORM public.lock_upload_storage_path(v_bucket, v_path);

  IF EXISTS (
    SELECT 1 FROM public.upload_path_tombstones AS tombstone
    WHERE tombstone.bucket_id = v_bucket AND tombstone.storage_path = v_path
  ) THEN
    RAISE EXCEPTION 'Upload path has been permanently revoked' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM public.upload_byte_reservations
  WHERE id = p_upload_id OR (bucket_id = v_bucket AND storage_path = v_path)
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.id = p_upload_id
      AND v_existing.user_id = p_user_id
      AND v_existing.bucket_id = v_bucket
      AND v_existing.storage_path = v_path
      AND v_existing.declared_bytes = v_declared
      AND v_existing.reserved_bytes = v_reserved
      AND v_existing.expected_content_type = v_expected_type
      AND v_existing.released_at IS NULL
      AND v_existing.finalization_status = 'reserved' THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'reason', 'already_reserved',
        'uploadId', v_existing.id,
        'reservedBytes', v_existing.reserved_bytes
      );
    END IF;
    RAISE EXCEPTION 'Upload reservation identifier or path collision';
  END IF;

  SELECT coalesce(sum(
    CASE
      WHEN reservation.actual_bytes IS NOT NULL
       AND reservation.actual_storage_id IS NOT NULL
       AND reservation.actual_storage_version IS NOT NULL
       AND reservation.finalization_status IN ('finalized', 'consuming', 'consumed')
       AND EXISTS (
         SELECT 1 FROM public.upload_path_tombstones AS tombstone
         WHERE tombstone.bucket_id = reservation.bucket_id
           AND tombstone.storage_path = reservation.storage_path
       )
        THEN reservation.actual_bytes
      ELSE reservation.reserved_bytes
    END
  ), 0)::bigint INTO v_user_outstanding
  FROM public.upload_byte_reservations AS reservation
  WHERE reservation.user_id = p_user_id AND reservation.released_at IS NULL;

  SELECT coalesce(sum(
    CASE
      WHEN reservation.actual_bytes IS NOT NULL
       AND reservation.actual_storage_id IS NOT NULL
       AND reservation.actual_storage_version IS NOT NULL
       AND reservation.finalization_status IN ('finalized', 'consuming', 'consumed')
       AND EXISTS (
         SELECT 1 FROM public.upload_path_tombstones AS tombstone
         WHERE tombstone.bucket_id = reservation.bucket_id
           AND tombstone.storage_path = reservation.storage_path
       )
        THEN reservation.actual_bytes
      ELSE reservation.reserved_bytes
    END
  ), 0)::bigint INTO v_global_outstanding
  FROM public.upload_byte_reservations AS reservation
  WHERE reservation.released_at IS NULL;

  IF v_user_outstanding + v_reserved > v_user_limit THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'user_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;
  IF v_global_outstanding + v_reserved > v_global_limit THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'global_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;

  INSERT INTO public.upload_byte_reservations (
    id, user_id, bucket_id, storage_path, declared_bytes, reserved_bytes,
    expected_content_type, created_at, expires_at, released_at,
    finalization_status, status_updated_at, legacy_compatibility_mode
  ) VALUES (
    p_upload_id, p_user_id, v_bucket, v_path, v_declared, v_reserved,
    v_expected_type, now(), now() + interval '10 minutes', NULL,
    'reserved', now(), false
  );

  RETURN jsonb_build_object(
    'allowed', true, 'reason', 'reserved', 'uploadId', p_upload_id,
    'reservedBytes', v_reserved,
    'userOutstandingBytes', v_user_outstanding + v_reserved,
    'globalOutstandingBytes', v_global_outstanding + v_reserved,
    'preIssueTtlSeconds', 600,
    'requestedTokenTtlSeconds', v_ttl
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_upload_byte_reservation_issued(
  p_upload_id uuid,
  p_user_id uuid,
  p_token_ttl_seconds integer DEFAULT 7200
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ttl integer := greatest(60, least(coalesce(p_token_ttl_seconds, 7200), 86400));
  v_row public.upload_byte_reservations%ROWTYPE;
BEGIN
  PERFORM public.lock_upload_owner(p_user_id);
  IF NOT public.is_upload_owner_active(p_user_id) THEN RETURN false; END IF;

  SELECT * INTO v_row FROM public.upload_byte_reservations
  WHERE id = p_upload_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_row.released_at IS NOT NULL THEN RETURN false; END IF;
  IF v_row.finalization_status = 'issued' THEN RETURN true; END IF;
  IF v_row.finalization_status <> 'reserved' OR v_row.expires_at <= now() THEN RETURN false; END IF;

  UPDATE public.upload_byte_reservations
  SET finalization_status = 'issued', issued_at = now(),
      expires_at = now() + make_interval(secs => v_ttl),
      status_updated_at = now()
  WHERE id = p_upload_id AND user_id = p_user_id
    AND finalization_status = 'reserved' AND released_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.abort_upload_byte_reservation_before_issue(
  p_upload_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.upload_byte_reservations
  SET finalization_status = 'released', released_at = now(), status_updated_at = now()
  WHERE id = p_upload_id AND user_id = p_user_id
    AND finalization_status = 'reserved' AND issued_at IS NULL AND released_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_upload_byte_reservation_consumption(
  p_upload_id uuid,
  p_user_id uuid,
  p_lease_id uuid,
  p_lease_seconds integer,
  p_disposition text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_disposition text := lower(btrim(coalesce(p_disposition, '')));
  v_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 1800), 3600));
BEGIN
  IF p_lease_id IS NULL OR v_disposition NOT IN ('preserve', 'delete', 'draft') THEN
    RAISE EXCEPTION 'A lease and valid consumption disposition are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.lock_upload_owner(p_user_id);
  IF NOT public.is_upload_owner_active(p_user_id) THEN RETURN false; END IF;

  UPDATE public.upload_byte_reservations
  SET finalization_status = 'consuming',
      consumption_disposition = v_disposition,
      consumption_lease_id = p_lease_id,
      consumption_lease_expires_at = now() + make_interval(secs => v_seconds),
      status_updated_at = now()
  WHERE id = p_upload_id AND user_id = p_user_id
    AND finalization_status IN ('finalized', 'consumed')
    AND released_at IS NULL
    AND (consumption_disposition IS NULL OR consumption_disposition = v_disposition)
    AND consumption_lease_id IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_upload_byte_reservation_consumption(
  p_upload_id uuid,
  p_user_id uuid,
  p_lease_id uuid,
  p_disposition text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_disposition text := lower(btrim(coalesce(p_disposition, '')));
BEGIN
  UPDATE public.upload_byte_reservations
  SET finalization_status = 'consumed',
      consumed_at = coalesce(consumed_at, now()),
      consumption_lease_id = NULL,
      consumption_lease_expires_at = NULL,
      last_consumption_lease_id = p_lease_id,
      consumption_outcome_unknown_at = NULL,
      status_updated_at = now()
  WHERE id = p_upload_id AND user_id = p_user_id
    AND finalization_status = 'consuming'
    AND consumption_lease_id = p_lease_id
    AND consumption_disposition = v_disposition
    AND released_at IS NULL;
  IF FOUND THEN RETURN true; END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.upload_byte_reservations
    WHERE id = p_upload_id AND user_id = p_user_id
      AND finalization_status = 'consumed'
      AND last_consumption_lease_id = p_lease_id
      AND consumption_disposition = v_disposition
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.abort_upload_byte_reservation_consumption(
  p_upload_id uuid,
  p_user_id uuid,
  p_lease_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.upload_byte_reservations
  SET finalization_status = CASE WHEN consumed_at IS NULL THEN 'finalized' ELSE 'consumed' END,
      consumption_disposition = CASE
        WHEN consumed_at IS NULL THEN NULL ELSE consumption_disposition END,
      consumption_lease_id = NULL,
      consumption_lease_expires_at = NULL,
      status_updated_at = now()
  WHERE id = p_upload_id AND user_id = p_user_id
    AND finalization_status = 'consuming'
    AND consumption_lease_id = p_lease_id
    AND released_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Rolling servers still call the seven-argument reservation function and do
-- not understand uploadId. They get a conservative legacy marker and an
-- issued capability in the same transaction. An already-issued retry is not
-- allowed to mint a fresh token whose expiry the database did not re-anchor.
CREATE OR REPLACE FUNCTION public.reserve_upload_bytes(
  p_user_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_declared_bytes bigint,
  p_user_limit_bytes bigint,
  p_global_limit_bytes bigint,
  p_ttl_seconds integer DEFAULT 7200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_bucket text := btrim(coalesce(p_bucket_id, ''));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_upload_id uuid;
  v_result jsonb;
  v_reserved bigint := public.upload_surface_max_bytes(p_bucket_id);
BEGIN
  IF v_reserved IS NULL THEN
    RAISE EXCEPTION 'Unknown upload surface' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_upload_owner(p_user_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('upload-byte-admission', 0));

  SELECT id INTO v_upload_id
  FROM public.upload_byte_reservations
  WHERE user_id = p_user_id AND bucket_id = v_bucket AND storage_path = v_path
  FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'already_issued',
      'userOutstandingBytes', NULL,
      'globalOutstandingBytes', NULL
    );
  END IF;
  v_upload_id := gen_random_uuid();

  v_result := public.reserve_upload_bytes_v2(
    v_upload_id, p_user_id, v_bucket, v_path, p_declared_bytes,
    v_reserved, 'application/octet-stream',
    p_user_limit_bytes, p_global_limit_bytes, p_ttl_seconds
  );
  IF coalesce((v_result ->> 'allowed')::boolean, false) = false THEN
    RETURN v_result - 'uploadId';
  END IF;

  UPDATE public.upload_byte_reservations
  SET legacy_compatibility_mode = true, status_updated_at = now()
  WHERE id = v_upload_id AND finalization_status = 'reserved';
  IF NOT public.mark_upload_byte_reservation_issued(
    v_upload_id, p_user_id, least(coalesce(p_ttl_seconds, 7200) + 600, 86400)
  ) THEN
    RAISE EXCEPTION 'Could not activate legacy upload reservation';
  END IF;
  RETURN v_result - 'uploadId';
END;
$$;

-- The old consume call arrives after an application commit but before trusted
-- Storage metadata existed in the schema. Revoke replay immediately and record
-- a conservative disposition without pretending metadata has been verified.
CREATE OR REPLACE FUNCTION public.consume_upload_byte_reservation(
  p_user_id uuid,
  p_bucket_id text,
  p_storage_path text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.upload_byte_reservations%ROWTYPE;
  v_disposition text;
BEGIN
  SELECT * INTO v_row FROM public.upload_byte_reservations
  WHERE user_id = p_user_id
    AND bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND released_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_disposition := CASE v_row.bucket_id
    WHEN 'uploads' THEN 'draft'
    WHEN 'template_inputs' THEN 'delete'
    ELSE 'preserve'
  END;
  PERFORM public.tombstone_upload_path(
    v_row.bucket_id, v_row.storage_path, v_row.id, v_row.user_id,
    'legacy_consumption'
  );

  UPDATE public.upload_byte_reservations
  SET consumption_disposition = coalesce(consumption_disposition, v_disposition),
      consumed_at = coalesce(consumed_at, now()),
      finalization_status = CASE
        WHEN finalization_status = 'finalized' THEN 'consumed'
        ELSE finalization_status
      END,
      status_updated_at = now()
  WHERE id = v_row.id
    AND finalization_status IN ('issued', 'finalized', 'consumed');
  RETURN FOUND;
END;
$$;

-- Path-only release is ambiguous during a rolling deploy. It may mean signing
-- failed, or it may follow cleanup while an issued token is still live. Revoke
-- the path and retain capacity; the reclaimer releases only after trusted 404
-- or preserves a bound legacy object conservatively.
CREATE OR REPLACE FUNCTION public.release_upload_byte_reservation(
  p_bucket_id text,
  p_storage_path text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.upload_byte_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.upload_byte_reservations
  WHERE bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND released_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.tombstone_upload_path(
    v_row.bucket_id, v_row.storage_path, v_row.id, v_row.user_id,
    'legacy_release'
  );
  UPDATE public.upload_byte_reservations
  SET status_updated_at = now()
  WHERE id = v_row.id AND released_at IS NULL;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_account_deleted_upload_reservations(
  p_owner_user_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_row public.upload_byte_reservations%ROWTYPE;
  v_marked integer := 0;
BEGIN
  IF p_owner_user_ids IS NULL OR cardinality(p_owner_user_ids) = 0
    OR array_position(p_owner_user_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'At least one exact upload owner is required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_owner IN
    SELECT DISTINCT owner_id FROM unnest(p_owner_user_ids) AS owners(owner_id)
    ORDER BY owner_id
  LOOP
    PERFORM public.lock_upload_owner(v_owner);
    INSERT INTO public.blocked_upload_owners(owner_user_id, reason)
    VALUES (v_owner, 'account_deletion')
    ON CONFLICT (owner_user_id) DO NOTHING;

    FOR v_row IN
      SELECT * FROM public.upload_byte_reservations
      WHERE user_id = v_owner AND released_at IS NULL
      ORDER BY bucket_id, storage_path
      FOR UPDATE
    LOOP
      PERFORM public.tombstone_upload_path(
        v_row.bucket_id, v_row.storage_path, v_row.id, v_row.user_id,
        'account_deletion'
      );
      UPDATE public.upload_byte_reservations
      SET finalization_status = 'deleted',
          consumption_lease_id = NULL,
          consumption_lease_expires_at = NULL,
          consumption_outcome_unknown_at = coalesce(
            consumption_outcome_unknown_at,
            CASE WHEN v_row.finalization_status = 'consuming' THEN now() ELSE NULL END
          ),
          status_updated_at = now()
      WHERE id = v_row.id AND released_at IS NULL
        AND finalization_status <> 'deleted';
      IF FOUND THEN v_marked := v_marked + 1; END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'ok', 'marked', v_marked);
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_upload_byte_reservations(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT reservation.id
    FROM public.upload_byte_reservations AS reservation
    WHERE reservation.released_at IS NOT NULL
      AND reservation.released_at < now() - interval '1 day'
      AND (
        reservation.issued_at IS NULL
        OR EXISTS (
          SELECT 1 FROM public.upload_path_tombstones AS tombstone
          WHERE tombstone.bucket_id = reservation.bucket_id
            AND tombstone.storage_path = reservation.storage_path
        )
      )
    ORDER BY reservation.released_at, reservation.id
    LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
    FOR UPDATE OF reservation SKIP LOCKED
  )
  DELETE FROM public.upload_byte_reservations AS reservation
  USING victims WHERE reservation.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.upload_surface_max_bytes(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_upload_owner_active(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.mark_upload_byte_reservation_issued(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_upload_byte_reservation_issued(uuid, uuid, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.abort_upload_byte_reservation_before_issue(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abort_upload_byte_reservation_before_issue(uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.claim_upload_byte_reservation_consumption(
  uuid, uuid, uuid, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_upload_byte_reservation_consumption(
  uuid, uuid, uuid, integer, text
) TO service_role;
REVOKE ALL ON FUNCTION public.complete_upload_byte_reservation_consumption(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_upload_byte_reservation_consumption(
  uuid, uuid, uuid, text
) TO service_role;
REVOKE ALL ON FUNCTION public.abort_upload_byte_reservation_consumption(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abort_upload_byte_reservation_consumption(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.mark_account_deleted_upload_reservations(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_account_deleted_upload_reservations(uuid[])
  TO service_role;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
) TO service_role;
REVOKE ALL ON FUNCTION public.consume_upload_byte_reservation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_upload_byte_reservation(uuid, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_upload_byte_reservation(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_upload_byte_reservation(text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.prune_upload_byte_reservations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_upload_byte_reservations(integer)
  TO service_role;

COMMENT ON TABLE public.upload_path_tombstones IS
  'Permanent revocation for a once-issued upload path. Never pruned: it blocks token replay after reservation bookkeeping is gone.';
COMMENT ON TABLE public.blocked_upload_owners IS
  'Permanent upload admission block established before account-deletion Storage sweeps.';
COMMENT ON COLUMN public.upload_byte_reservations.legacy_compatibility_mode IS
  'True only for path-only v1 rows created before explicit uploadId finalization became authoritative.';
COMMENT ON COLUMN public.upload_byte_reservations.consumption_outcome_unknown_at IS
  'Set when a lease expires after a consumer may have committed; present objects are retained and actual-byte charged until exact retry or trusted absence.';

-- Signed upload admission must account for the most bytes the issued URL can
-- write, not the untrusted size a client declares. The reservation row is also
-- the durable, server-owned upload intent used by the finalizer and reclaim
-- worker. Capacity is released only after trusted consumption or confirmed
-- deletion; expiry merely makes an unfinalized object eligible for reclaim.

ALTER TABLE public.upload_byte_reservations
  ADD COLUMN IF NOT EXISTS reserved_bytes bigint,
  ADD COLUMN IF NOT EXISTS expected_content_type text,
  ADD COLUMN IF NOT EXISTS actual_bytes bigint,
  ADD COLUMN IF NOT EXISTS actual_content_type text,
  ADD COLUMN IF NOT EXISTS actual_storage_id uuid,
  ADD COLUMN IF NOT EXISTS actual_storage_version text,
  ADD COLUMN IF NOT EXISTS finalization_status text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumption_disposition text,
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS reclaim_not_before timestamptz;

-- A signed URL can outlive its Auth user during account deletion. Cascading
-- the reservation with auth.users would erase the only durable record the
-- storage reclaimer has while that URL can still materialize an object.
ALTER TABLE public.upload_byte_reservations
  DROP CONSTRAINT IF EXISTS upload_byte_reservations_user_id_fkey;

COMMENT ON COLUMN public.upload_byte_reservations.user_id IS
  'Issuing owner identifier retained after Auth deletion until the reserved object is finalized, consumed, or confirmed deleted.';

UPDATE public.upload_byte_reservations
SET reserved_bytes = greatest(
      coalesce(reserved_bytes, 0),
      declared_bytes,
      CASE btrim(bucket_id)
        WHEN 'profiles' THEN 5 * 1024 * 1024
        WHEN 'generated_images' THEN 25 * 1024 * 1024
        WHEN 'generated_videos' THEN 250 * 1024 * 1024
        WHEN 'generated_audio' THEN 50 * 1024 * 1024
        WHEN 'post_resource_files' THEN 50 * 1024 * 1024
        WHEN 'template_inputs' THEN 100 * 1024 * 1024
        WHEN 'uploads' THEN 250 * 1024 * 1024
        ELSE declared_bytes
      END
    ),
    expected_content_type = coalesce(
      nullif(lower(btrim(expected_content_type)), ''),
      'application/octet-stream'
    ),
    finalization_status = coalesce(
      finalization_status,
      CASE WHEN released_at IS NULL THEN 'issued' ELSE 'released' END
    ),
    status_updated_at = coalesce(status_updated_at, created_at, now())
WHERE reserved_bytes IS NULL
   OR expected_content_type IS NULL
   OR btrim(expected_content_type) = ''
   OR finalization_status IS NULL
   OR status_updated_at IS NULL;

-- Existing rows were issued before reservations carried the ten-minute grace
-- used by v2 below. Their signed Storage tokens can therefore remain valid for
-- a short interval after expires_at. Extend every still-outstanding legacy row
-- once so the reclaim worker cannot race a token that was already issued.
UPDATE public.upload_byte_reservations
SET expires_at = greatest(expires_at, now()) + interval '10 minutes',
    status_updated_at = now()
WHERE released_at IS NULL
  AND finalization_status IN ('issued', 'finalizing', 'reclaiming');

ALTER TABLE public.upload_byte_reservations
  ALTER COLUMN reserved_bytes SET NOT NULL,
  ALTER COLUMN expected_content_type SET NOT NULL,
  ALTER COLUMN finalization_status SET DEFAULT 'issued',
  ALTER COLUMN finalization_status SET NOT NULL,
  ALTER COLUMN status_updated_at SET DEFAULT now(),
  ALTER COLUMN status_updated_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_reserved_bytes_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_reserved_bytes_check
      CHECK (reserved_bytes >= declared_bytes AND reserved_bytes > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_expected_content_type_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_expected_content_type_check
      CHECK (btrim(expected_content_type) <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_actual_bytes_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_actual_bytes_check
      CHECK (actual_bytes IS NULL OR actual_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_storage_identity_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_storage_identity_check
      CHECK (
        (
          actual_storage_id IS NULL
          AND actual_storage_version IS NULL
        )
        OR (
          actual_storage_id IS NOT NULL
          AND actual_storage_version IS NOT NULL
          AND btrim(actual_storage_version) <> ''
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_consumption_disposition_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_consumption_disposition_check
      CHECK (
        consumption_disposition IS NULL
        OR consumption_disposition IN ('preserve', 'delete', 'draft')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_finalization_status_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_finalization_status_check
      CHECK (finalization_status IN (
        'issued', 'finalizing', 'finalized', 'consumed',
        'reclaiming', 'deleted', 'released'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_reclaim_quiescence_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_reclaim_quiescence_check
      CHECK (
        reclaim_not_before IS NULL
        OR reclaim_not_before >= expires_at + interval '10 minutes'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'upload_byte_reservations_safe_release_check'
      AND conrelid = 'public.upload_byte_reservations'::regclass
  ) THEN
    ALTER TABLE public.upload_byte_reservations
      ADD CONSTRAINT upload_byte_reservations_safe_release_check
      CHECK (
        released_at IS NULL
        -- `released` is reserved for a reservation whose Storage signer never
        -- returned a token, so there is no replay window to wait out.
        OR (
          finalization_status = 'released'
          AND finalized_at IS NULL
          AND consumed_at IS NULL
          AND actual_bytes IS NULL
          AND reclaim_not_before IS NULL
        )
        -- Every issued-token path must complete a post-expiry observation and
        -- the full quiescence interval before its capacity can be released.
        OR (
          reclaim_not_before IS NOT NULL
          AND released_at >= reclaim_not_before
        )
      );
  END IF;
END
$$;

-- Enforce the replay-sensitive lifecycle in the database, not only in the
-- reclaim worker. In particular a single service-role UPDATE cannot backdate a
-- quiescence gate and release capacity in the same pass.
CREATE OR REPLACE FUNCTION public.enforce_upload_byte_reservation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF ROW(
    NEW.id,
    NEW.user_id,
    NEW.bucket_id,
    NEW.storage_path,
    NEW.declared_bytes,
    NEW.reserved_bytes,
    NEW.expected_content_type,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.user_id,
    OLD.bucket_id,
    OLD.storage_path,
    OLD.declared_bytes,
    OLD.reserved_bytes,
    OLD.expected_content_type,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Upload reservation identity and expiry are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.actual_bytes IS NOT NULL
    AND NEW.actual_bytes IS DISTINCT FROM OLD.actual_bytes THEN
    RAISE EXCEPTION 'Finalized upload byte metadata is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_content_type IS NOT NULL
    AND NEW.actual_content_type IS DISTINCT FROM OLD.actual_content_type THEN
    RAISE EXCEPTION 'Finalized upload content metadata is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_storage_id IS NOT NULL
    AND NEW.actual_storage_id IS DISTINCT FROM OLD.actual_storage_id THEN
    RAISE EXCEPTION 'Finalized Storage object identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.actual_storage_version IS NOT NULL
    AND NEW.actual_storage_version IS DISTINCT FROM OLD.actual_storage_version THEN
    RAISE EXCEPTION 'Finalized Storage object version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.finalized_at IS NOT NULL
    AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'Upload finalization time is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL
    AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'Upload consumption time is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.consumption_disposition IS NOT NULL
    AND NEW.consumption_disposition IS DISTINCT FROM OLD.consumption_disposition THEN
    RAISE EXCEPTION 'Upload consumption disposition is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status IN ('finalized', 'consumed')
    AND (
      NEW.actual_bytes IS NULL
      OR NEW.actual_content_type IS NULL
      OR btrim(NEW.actual_content_type) = ''
      OR NEW.actual_storage_id IS NULL
      OR NEW.actual_storage_version IS NULL
      OR NEW.finalized_at IS NULL
    ) THEN
    RAISE EXCEPTION 'Finalized uploads require trusted object metadata and version identity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status = 'consumed'
    AND (NEW.consumed_at IS NULL OR NEW.consumption_disposition IS NULL) THEN
    RAISE EXCEPTION 'Consumed uploads require a durable disposition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.finalization_status IS DISTINCT FROM OLD.finalization_status
    AND NOT (
      (OLD.finalization_status = 'issued'
        AND NEW.finalization_status IN ('finalizing', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'finalizing'
        AND NEW.finalization_status IN ('issued', 'finalized', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'finalized'
        AND NEW.finalization_status IN ('consumed', 'deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'consumed'
        AND NEW.finalization_status IN ('deleted', 'reclaiming'))
      OR (OLD.finalization_status = 'deleted'
        AND NEW.finalization_status = 'reclaiming')
      OR (OLD.finalization_status = 'reclaiming'
        AND NEW.finalization_status IN ('reclaiming', 'consumed', 'deleted'))
    ) THEN
    RAISE EXCEPTION 'Invalid upload reservation lifecycle transition: % -> %',
      OLD.finalization_status,
      NEW.finalization_status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.reclaim_not_before IS NULL AND NEW.reclaim_not_before IS NOT NULL THEN
    IF OLD.expires_at > now()
      OR NEW.finalization_status <> 'reclaiming'
      OR NEW.released_at IS NOT NULL
      OR NEW.reclaim_not_before < now() + interval '10 minutes' THEN
      RAISE EXCEPTION 'The first reclaim pass must begin after expiry and preserve a full quiescence interval'
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.reclaim_not_before IS NOT NULL
    AND NEW.reclaim_not_before IS DISTINCT FROM OLD.reclaim_not_before THEN
    RAISE EXCEPTION 'The reclaim quiescence gate is immutable once observed'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.released_at IS NOT NULL
    AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'Upload reservation release time is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
    IF OLD.finalization_status <> 'reclaiming'
      OR OLD.reclaim_not_before IS NULL
      OR OLD.reclaim_not_before > now()
      OR NEW.reclaim_not_before IS DISTINCT FROM OLD.reclaim_not_before THEN
      RAISE EXCEPTION 'Upload capacity requires a stale second-pass reclaim before release'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS upload_byte_reservations_enforce_lifecycle
  ON public.upload_byte_reservations;
CREATE TRIGGER upload_byte_reservations_enforce_lifecycle
BEFORE UPDATE ON public.upload_byte_reservations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_upload_byte_reservation_lifecycle();

REVOKE ALL ON FUNCTION public.enforce_upload_byte_reservation_lifecycle()
  FROM PUBLIC, anon, authenticated;

DROP INDEX IF EXISTS public.upload_byte_reservations_active_user_idx;
DROP INDEX IF EXISTS public.upload_byte_reservations_active_global_idx;

CREATE INDEX upload_byte_reservations_active_user_idx
  ON public.upload_byte_reservations (user_id)
  INCLUDE (reserved_bytes, actual_bytes, finalization_status)
  WHERE released_at IS NULL;

CREATE INDEX upload_byte_reservations_active_global_idx
  ON public.upload_byte_reservations (id)
  INCLUDE (reserved_bytes, actual_bytes, finalization_status)
  WHERE released_at IS NULL;

DROP INDEX IF EXISTS public.upload_byte_reservations_expired_unfinalized_idx;
CREATE INDEX IF NOT EXISTS upload_byte_reservations_expired_reclaimable_idx
  ON public.upload_byte_reservations (expires_at, reclaim_not_before, id)
  WHERE released_at IS NULL
    AND finalization_status IN (
      'issued', 'finalizing', 'finalized', 'consumed', 'deleted', 'reclaiming'
    );

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bucket text := btrim(coalesce(p_bucket_id, ''));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_expected_type text := lower(btrim(coalesce(p_expected_content_type, '')));
  v_declared bigint := greatest(coalesce(p_declared_bytes, 0), 0);
  v_reserved bigint := greatest(coalesce(p_reserved_bytes, 0), 0);
  v_user_limit bigint := greatest(coalesce(p_user_limit_bytes, 0), 1);
  v_global_limit bigint := greatest(coalesce(p_global_limit_bytes, 0), 1);
  v_ttl integer := greatest(coalesce(p_ttl_seconds, 7200), 60);
  v_user_outstanding bigint;
  v_global_outstanding bigint;
  v_existing public.upload_byte_reservations%ROWTYPE;
BEGIN
  IF p_upload_id IS NULL OR p_user_id IS NULL OR v_bucket = '' OR v_path = ''
     OR v_declared <= 0 OR v_reserved < v_declared OR v_expected_type = '' THEN
    RAISE EXCEPTION 'A unique upload, user, bucket, path, expected type, and valid byte bounds are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('upload-byte-admission', 0));

  SELECT * INTO v_existing
  FROM public.upload_byte_reservations
  WHERE id = p_upload_id OR (bucket_id = v_bucket AND storage_path = v_path)
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.id = p_upload_id
       AND v_existing.user_id = p_user_id
       AND v_existing.bucket_id = v_bucket
       AND v_existing.storage_path = v_path
       AND v_existing.released_at IS NULL THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'reason', 'already_reserved',
        'uploadId', v_existing.id
      );
    END IF;
    RAISE EXCEPTION 'Upload reservation identifier or path collision';
  END IF;

  -- Expired rows remain outstanding until the reclaim worker proves the
  -- corresponding object is absent. Omitting an expires_at predicate here is
  -- the critical difference from the legacy admission function.
  SELECT coalesce(sum(reserved_bytes), 0)::bigint INTO v_user_outstanding
  FROM public.upload_byte_reservations
  WHERE user_id = p_user_id AND released_at IS NULL;

  SELECT coalesce(sum(reserved_bytes), 0)::bigint INTO v_global_outstanding
  FROM public.upload_byte_reservations
  WHERE released_at IS NULL;

  IF v_user_outstanding + v_reserved > v_user_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'user_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;

  IF v_global_outstanding + v_reserved > v_global_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'global_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;

  INSERT INTO public.upload_byte_reservations (
    id, user_id, bucket_id, storage_path, declared_bytes, reserved_bytes,
    expected_content_type, created_at, expires_at, released_at,
    finalization_status, status_updated_at
  ) VALUES (
    p_upload_id, p_user_id, v_bucket, v_path, v_declared, v_reserved,
    -- The reservation must outlive the Storage signed-upload token. Signing
    -- happens only after this transaction commits, so an equal TTL would let
    -- reclaim race a token that is still valid. Keep a fixed ten-minute grace.
    v_expected_type, now(), now() + make_interval(secs => v_ttl + 600), NULL,
    'issued', now()
  );

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'reserved',
    'uploadId', p_upload_id,
    'reservedBytes', v_reserved,
    'userOutstandingBytes', v_user_outstanding + v_reserved,
    'globalOutstandingBytes', v_global_outstanding + v_reserved
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_upload_byte_reservation(
  p_user_id uuid,
  p_bucket_id text,
  p_storage_path text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_consumed boolean;
BEGIN
  UPDATE public.upload_byte_reservations
  SET consumed_at = coalesce(consumed_at, now()),
      finalization_status = 'consumed',
      status_updated_at = now()
  WHERE user_id = p_user_id
    AND bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND finalization_status IN ('finalized', 'consumed')
    AND released_at IS NULL
  RETURNING true INTO v_consumed;
  RETURN coalesce(v_consumed, false);
END;
$$;

-- Rolling application instances can still call v1. Charge the largest object
-- the named surface can accept so the compatibility path cannot under-reserve.
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reserved bigint := CASE btrim(coalesce(p_bucket_id, ''))
    WHEN 'profiles' THEN 5 * 1024 * 1024
    WHEN 'generated_images' THEN 25 * 1024 * 1024
    WHEN 'generated_videos' THEN 250 * 1024 * 1024
    WHEN 'generated_audio' THEN 50 * 1024 * 1024
    WHEN 'post_resource_files' THEN 50 * 1024 * 1024
    WHEN 'template_inputs' THEN 100 * 1024 * 1024
    WHEN 'uploads' THEN 250 * 1024 * 1024
    ELSE 250 * 1024 * 1024
  END;
  v_upload_id uuid;
BEGIN
  -- Legacy callers have no uploadId, so retain their path-based idempotency.
  -- Take the same admission lock before discovering/generating the opaque ID;
  -- otherwise two rolling instances could race and turn an ordinary retry into
  -- an identifier collision inside v2.
  PERFORM pg_advisory_xact_lock(hashtextextended('upload-byte-admission', 0));
  SELECT id INTO v_upload_id
  FROM public.upload_byte_reservations
  WHERE user_id = p_user_id
    AND bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND released_at IS NULL
  FOR UPDATE;
  v_upload_id := coalesce(v_upload_id, gen_random_uuid());

  RETURN public.reserve_upload_bytes_v2(
    v_upload_id, p_user_id, p_bucket_id, p_storage_path,
    p_declared_bytes, greatest(v_reserved, p_declared_bytes),
    'application/octet-stream', p_user_limit_bytes, p_global_limit_bytes,
    p_ttl_seconds
  ) - 'uploadId';
END;
$$;

CREATE OR REPLACE FUNCTION public.release_upload_byte_reservation(
  p_bucket_id text,
  p_storage_path text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_released boolean;
BEGIN
  UPDATE public.upload_byte_reservations
  SET released_at = CASE
        -- This path is called synchronously when Storage signing failed, so an
        -- issued URL never existed and capacity can be returned immediately.
        WHEN finalization_status = 'issued' THEN now()
        ELSE released_at
      END,
      finalization_status = CASE
        WHEN finalization_status = 'issued' THEN 'released'
        -- A finalized/consumed object can still be overwritten by its issued
        -- token. Record confirmed cleanup, but keep charging it until the
        -- post-expiry two-pass reclaimer observes quiescence.
        ELSE 'deleted'
      END,
      status_updated_at = now()
  WHERE bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND released_at IS NULL
    AND finalization_status IN ('issued', 'finalized', 'consumed', 'deleted')
  RETURNING true INTO v_released;
  RETURN coalesce(v_released, false);
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.consume_upload_byte_reservation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_upload_byte_reservation(uuid, text, text)
  TO service_role;

COMMENT ON COLUMN public.upload_byte_reservations.id IS
  'Opaque uploadId returned to clients and accepted by the generic finalizer.';
COMMENT ON COLUMN public.upload_byte_reservations.reserved_bytes IS
  'Server-calculated maximum bytes this signed upload URL can write; never client-declared.';
COMMENT ON COLUMN public.upload_byte_reservations.finalization_status IS
  'Server-owned upload lifecycle. Expiry is eligibility for reclaim, not proof that capacity can be released.';
COMMENT ON COLUMN public.upload_byte_reservations.consumed_at IS
  'When a trusted application operation durably referenced or copied the finalized object. Capacity remains charged through token expiry and reclaim quiescence.';
COMMENT ON COLUMN public.upload_byte_reservations.reclaim_not_before IS
  'Second-pass reclaim gate. The first post-expiry observation sets this at least ten minutes after expires_at; storage may be rechecked and capacity released only once it has passed.';

-- The old retention function treated expires_at as permission to delete the
-- reservation row. Expiry only says the signed URL cannot be used any more; it
-- says nothing about whether an uploaded object still exists. The application
-- reclaim worker now performs and confirms that storage deletion first. This
-- prune may remove only already-released bookkeeping after a retry window.
CREATE OR REPLACE FUNCTION public.prune_upload_byte_reservations(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT id FROM public.upload_byte_reservations
    WHERE released_at IS NOT NULL
      AND released_at < now() - interval '1 day'
    ORDER BY released_at, id
    LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.upload_byte_reservations AS reservations
  USING victims WHERE reservations.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

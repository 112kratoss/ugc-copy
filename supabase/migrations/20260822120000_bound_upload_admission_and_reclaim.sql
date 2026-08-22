-- Make upload byte admission constant-cost and make reclaim scheduling visible.
--
-- Exact global byte admission necessarily contends on one small aggregate row,
-- but it no longer holds an advisory lock while scanning every outstanding
-- reservation. Per-user and global totals are maintained transactionally by a
-- trigger, and a service-role reconciliation function detects/corrects drift.

CREATE TABLE IF NOT EXISTS public.upload_byte_global_counters (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  outstanding_bytes bigint NOT NULL DEFAULT 0 CHECK (outstanding_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.upload_byte_user_counters (
  user_id uuid PRIMARY KEY,
  outstanding_bytes bigint NOT NULL DEFAULT 0 CHECK (outstanding_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.upload_byte_global_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_byte_user_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.upload_byte_global_counters FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.upload_byte_user_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.upload_byte_global_counters TO service_role;
GRANT SELECT ON public.upload_byte_user_counters TO service_role;

ALTER TABLE public.upload_byte_reservations
  ADD COLUMN IF NOT EXISTS reclaim_after timestamptz;

COMMENT ON COLUMN public.upload_byte_reservations.reclaim_after IS
  'Worker scheduling hint. Protected expired rows are excluded until this time; it is not the two-observation reclaim_not_before safety gate.';

DROP INDEX IF EXISTS public.upload_byte_reservations_expired_reclaimable_idx;
CREATE INDEX upload_byte_reservations_expired_reclaimable_idx
  ON public.upload_byte_reservations (expires_at, id)
  INCLUDE (reclaim_after)
  WHERE released_at IS NULL
    AND finalization_status IN (
      'reserved', 'issued', 'finalizing', 'finalized',
      'consuming', 'consumed', 'deleted', 'reclaiming'
    );

CREATE INDEX upload_byte_reservations_deferred_reclaim_idx
  ON public.upload_byte_reservations (reclaim_after, id)
  INCLUDE (expires_at)
  WHERE released_at IS NULL
    AND reclaim_after IS NOT NULL
    AND finalization_status IN (
      'reserved', 'issued', 'finalizing', 'finalized',
      'consuming', 'consumed', 'deleted', 'reclaiming'
    );

CREATE OR REPLACE FUNCTION public.upload_byte_reservation_charge(
  p_reservation public.upload_byte_reservations
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (p_reservation).released_at IS NOT NULL THEN 0::bigint
    WHEN (p_reservation).actual_bytes IS NOT NULL
      AND (p_reservation).actual_storage_id IS NOT NULL
      AND (p_reservation).actual_storage_version IS NOT NULL
      AND (p_reservation).finalization_status IN ('finalized', 'consuming', 'consumed')
      AND EXISTS (
        SELECT 1
        FROM public.upload_path_tombstones AS tombstone
        WHERE tombstone.bucket_id = (p_reservation).bucket_id
          AND tombstone.storage_path = (p_reservation).storage_path
      )
      THEN (p_reservation).actual_bytes
    ELSE (p_reservation).reserved_bytes
  END;
$$;

REVOKE ALL ON FUNCTION public.upload_byte_reservation_charge(
  public.upload_byte_reservations
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_upload_byte_admission_counters()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_charge bigint := CASE WHEN TG_OP = 'INSERT'
    THEN 0 ELSE public.upload_byte_reservation_charge(OLD) END;
  v_new_charge bigint := CASE WHEN TG_OP = 'DELETE'
    THEN 0 ELSE public.upload_byte_reservation_charge(NEW) END;
  v_global_delta bigint := v_new_charge - v_old_charge;
BEGIN
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
    UPDATE public.upload_byte_user_counters
    SET outstanding_bytes = outstanding_bytes - v_old_charge,
        updated_at = now()
    WHERE user_id = OLD.user_id
      AND outstanding_bytes >= v_old_charge;
    IF NOT FOUND AND v_old_charge <> 0 THEN
      RAISE EXCEPTION 'Upload byte user counter drift for %', OLD.user_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR OLD.user_id IS DISTINCT FROM NEW.user_id) THEN
    INSERT INTO public.upload_byte_user_counters (user_id, outstanding_bytes, updated_at)
    VALUES (NEW.user_id, v_new_charge, now())
    ON CONFLICT (user_id) DO UPDATE
    SET outstanding_bytes = public.upload_byte_user_counters.outstanding_bytes + EXCLUDED.outstanding_bytes,
        updated_at = EXCLUDED.updated_at;
  ELSIF TG_OP = 'UPDATE' AND v_global_delta <> 0 THEN
    UPDATE public.upload_byte_user_counters
    SET outstanding_bytes = outstanding_bytes + v_global_delta,
        updated_at = now()
    WHERE user_id = NEW.user_id
      AND outstanding_bytes + v_global_delta >= 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Upload byte user counter drift for %', NEW.user_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_global_delta <> 0 THEN
    UPDATE public.upload_byte_global_counters
    SET outstanding_bytes = outstanding_bytes + v_global_delta,
        updated_at = now()
    WHERE singleton = true
      AND outstanding_bytes + v_global_delta >= 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Upload byte global counter drift' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upload_byte_admission_counters()
  FROM PUBLIC, anon, authenticated, service_role;

-- Seed a transactionally consistent baseline before the maintenance trigger is
-- installed. A DO statement supplies one transaction in both the Supabase CLI
-- and Management API runners, without transaction-control statements that
-- could interfere with a runner-owned outer transaction. The lock, seed, and
-- trigger cutover are therefore atomic: no reservation write can land between
-- the baseline and trigger activation. This is a one-time migration scan, not
-- request-path work.
DO $seed_upload_admission_counters$
BEGIN
  LOCK TABLE public.upload_byte_reservations IN SHARE ROW EXCLUSIVE MODE;

  INSERT INTO public.upload_byte_global_counters (
    singleton, outstanding_bytes, updated_at
  )
  SELECT true,
         coalesce(sum(public.upload_byte_reservation_charge(reservation)), 0)::bigint,
         now()
  FROM public.upload_byte_reservations AS reservation
  ON CONFLICT (singleton) DO UPDATE
  SET outstanding_bytes = EXCLUDED.outstanding_bytes,
      updated_at = EXCLUDED.updated_at;

  TRUNCATE TABLE public.upload_byte_user_counters;
  INSERT INTO public.upload_byte_user_counters (
    user_id, outstanding_bytes, updated_at
  )
  SELECT reservation.user_id,
         sum(public.upload_byte_reservation_charge(reservation))::bigint,
         now()
  FROM public.upload_byte_reservations AS reservation
  GROUP BY reservation.user_id
  HAVING sum(public.upload_byte_reservation_charge(reservation)) > 0;

  EXECUTE 'DROP TRIGGER IF EXISTS upload_byte_reservations_sync_admission_counters '
    || 'ON public.upload_byte_reservations';
  EXECUTE 'CREATE TRIGGER upload_byte_reservations_sync_admission_counters '
    || 'AFTER INSERT OR UPDATE OR DELETE ON public.upload_byte_reservations '
    || 'FOR EACH ROW EXECUTE FUNCTION public.sync_upload_byte_admission_counters()';
END;
$seed_upload_admission_counters$;

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

  INSERT INTO public.upload_byte_user_counters (user_id, outstanding_bytes, updated_at)
  VALUES (p_user_id, 0, now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Lock order is always user then global, including the maintenance trigger.
  -- The global critical section is two indexed row reads plus one insert; no
  -- reservation or tombstone table scan occurs while it is held.
  SELECT outstanding_bytes INTO v_user_outstanding
  FROM public.upload_byte_user_counters
  WHERE user_id = p_user_id
  FOR UPDATE;

  SELECT outstanding_bytes INTO v_global_outstanding
  FROM public.upload_byte_global_counters
  WHERE singleton = true
  FOR UPDATE;

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

-- Remove the obsolete global advisory lock from the rolling compatibility RPC.
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

CREATE OR REPLACE FUNCTION public.reconcile_upload_byte_admission_counters(
  p_repair boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recorded_global bigint;
  v_calculated_global bigint;
  v_user_drift_count bigint;
BEGIN
  IF p_repair THEN
    LOCK TABLE public.upload_byte_reservations IN SHARE ROW EXCLUSIVE MODE;
  END IF;

  SELECT outstanding_bytes INTO v_recorded_global
  FROM public.upload_byte_global_counters WHERE singleton = true;
  SELECT coalesce(sum(public.upload_byte_reservation_charge(reservation)), 0)::bigint
  INTO v_calculated_global
  FROM public.upload_byte_reservations AS reservation;

  WITH calculated AS (
    SELECT reservation.user_id,
           sum(public.upload_byte_reservation_charge(reservation))::bigint AS outstanding_bytes
    FROM public.upload_byte_reservations AS reservation
    GROUP BY reservation.user_id
  ), drift AS (
    SELECT coalesce(recorded.user_id, calculated.user_id) AS user_id
    FROM public.upload_byte_user_counters AS recorded
    FULL JOIN calculated USING (user_id)
    WHERE coalesce(recorded.outstanding_bytes, 0)
      IS DISTINCT FROM coalesce(calculated.outstanding_bytes, 0)
  )
  SELECT count(*) INTO v_user_drift_count FROM drift;

  IF p_repair AND (
    v_recorded_global IS DISTINCT FROM v_calculated_global OR v_user_drift_count > 0
  ) THEN
    UPDATE public.upload_byte_global_counters
    SET outstanding_bytes = v_calculated_global, updated_at = now()
    WHERE singleton = true;
    TRUNCATE TABLE public.upload_byte_user_counters;
    INSERT INTO public.upload_byte_user_counters (user_id, outstanding_bytes, updated_at)
    SELECT reservation.user_id,
           sum(public.upload_byte_reservation_charge(reservation))::bigint,
           now()
    FROM public.upload_byte_reservations AS reservation
    GROUP BY reservation.user_id
    HAVING sum(public.upload_byte_reservation_charge(reservation)) > 0;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE
      WHEN v_recorded_global IS DISTINCT FROM v_calculated_global OR v_user_drift_count > 0
        THEN 'drift'
      ELSE 'ok'
    END,
    'recordedGlobalBytes', v_recorded_global,
    'calculatedGlobalBytes', v_calculated_global,
    'userDriftCount', v_user_drift_count,
    'repaired', p_repair AND (
      v_recorded_global IS DISTINCT FROM v_calculated_global OR v_user_drift_count > 0
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes_v2(
  uuid, uuid, text, text, bigint, bigint, text, bigint, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes(
  uuid, text, text, bigint, bigint, bigint, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_upload_byte_admission_counters(boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_upload_byte_admission_counters(boolean)
  TO service_role;

COMMENT ON FUNCTION public.reconcile_upload_byte_admission_counters(boolean) IS
  'Compares aggregate upload admission counters with authoritative reservations and optionally repairs them under a table lock. Service role only.';

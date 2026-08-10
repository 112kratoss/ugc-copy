-- Request-count limits do not bound bytes: the independent upload surfaces
-- could issue tens of gigabytes of signed writes in one window. Keep a short,
-- durable reservation for every signed URL and enforce both per-user and
-- project-wide outstanding-byte ceilings in one transaction.

CREATE TABLE IF NOT EXISTS public.upload_byte_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket_id text NOT NULL CHECK (btrim(bucket_id) <> ''),
  storage_path text NOT NULL CHECK (btrim(storage_path) <> ''),
  declared_bytes bigint NOT NULL CHECK (declared_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  UNIQUE (bucket_id, storage_path)
);

CREATE INDEX IF NOT EXISTS upload_byte_reservations_active_user_idx
  ON public.upload_byte_reservations (user_id, expires_at)
  INCLUDE (declared_bytes)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS upload_byte_reservations_active_global_idx
  ON public.upload_byte_reservations (expires_at)
  INCLUDE (declared_bytes)
  WHERE released_at IS NULL;

ALTER TABLE public.upload_byte_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.upload_byte_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_byte_reservations TO service_role;

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
  v_bucket text := btrim(coalesce(p_bucket_id, ''));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_bytes bigint := greatest(coalesce(p_declared_bytes, 0), 0);
  v_user_limit bigint := greatest(coalesce(p_user_limit_bytes, 0), 1);
  v_global_limit bigint := greatest(coalesce(p_global_limit_bytes, 0), 1);
  v_ttl integer := greatest(coalesce(p_ttl_seconds, 7200), 60);
  v_user_outstanding bigint;
  v_global_outstanding bigint;
  v_existing public.upload_byte_reservations%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR v_bucket = '' OR v_path = '' OR v_bytes <= 0 THEN
    RAISE EXCEPTION 'A user, bucket, path, and positive byte count are required';
  END IF;

  -- One global lock deliberately serialises the two sums with insertion. URL
  -- signing is low-rate control-plane work; correctness matters more than
  -- parallelising these millisecond transactions and overshooting the project
  -- storage ceiling during a burst.
  PERFORM pg_advisory_xact_lock(hashtextextended('upload-byte-admission', 0));

  SELECT * INTO v_existing
  FROM public.upload_byte_reservations
  WHERE bucket_id = v_bucket AND storage_path = v_path
  FOR UPDATE;

  IF FOUND AND v_existing.released_at IS NULL AND v_existing.expires_at > now() THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', 'already_reserved',
      'userOutstandingBytes', NULL,
      'globalOutstandingBytes', NULL
    );
  END IF;

  SELECT coalesce(sum(declared_bytes), 0)::bigint INTO v_user_outstanding
  FROM public.upload_byte_reservations
  WHERE user_id = p_user_id AND released_at IS NULL AND expires_at > now();

  SELECT coalesce(sum(declared_bytes), 0)::bigint INTO v_global_outstanding
  FROM public.upload_byte_reservations
  WHERE released_at IS NULL AND expires_at > now();

  IF v_user_outstanding + v_bytes > v_user_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'user_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;

  IF v_global_outstanding + v_bytes > v_global_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'global_byte_limit',
      'userOutstandingBytes', v_user_outstanding,
      'globalOutstandingBytes', v_global_outstanding
    );
  END IF;

  INSERT INTO public.upload_byte_reservations (
    user_id, bucket_id, storage_path, declared_bytes, expires_at, released_at
  ) VALUES (
    p_user_id, v_bucket, v_path, v_bytes,
    now() + make_interval(secs => v_ttl), NULL
  )
  ON CONFLICT (bucket_id, storage_path) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      declared_bytes = EXCLUDED.declared_bytes,
      created_at = now(),
      expires_at = EXCLUDED.expires_at,
      released_at = NULL;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', 'reserved',
    'userOutstandingBytes', v_user_outstanding + v_bytes,
    'globalOutstandingBytes', v_global_outstanding + v_bytes
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_upload_byte_reservation(
  p_bucket_id text,
  p_storage_path text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.upload_byte_reservations
  SET released_at = coalesce(released_at, now())
  WHERE bucket_id = btrim(coalesce(p_bucket_id, ''))
    AND storage_path = btrim(coalesce(p_storage_path, ''))
    AND released_at IS NULL
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.reserve_upload_bytes(uuid, text, text, bigint, bigint, bigint, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_upload_bytes(uuid, text, text, bigint, bigint, bigint, integer)
  TO service_role;
REVOKE ALL ON FUNCTION public.release_upload_byte_reservation(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_upload_byte_reservation(text, text)
  TO service_role;

COMMENT ON TABLE public.upload_byte_reservations IS
  'Short-lived per-user and project-wide outstanding-byte admission for every server-issued signed upload URL.';

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS client_request_key_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'generations_client_request_key_hash_sha256'
      AND conrelid = 'public.generations'::regclass
  ) THEN
    ALTER TABLE public.generations
      ADD CONSTRAINT generations_client_request_key_hash_sha256
      CHECK (
        client_request_key_hash IS NULL
        OR client_request_key_hash ~ '^[a-f0-9]{64}$'
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS generations_user_client_request_key_hash_idx
  ON public.generations (user_id, client_request_key_hash)
  WHERE client_request_key_hash IS NOT NULL;

COMMENT ON COLUMN public.generations.client_request_key_hash IS
  'SHA-256 hash of a caller-provided generation start idempotency key. Raw keys are never stored.';

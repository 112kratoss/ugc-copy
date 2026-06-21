ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS client_request_key_hash text,
  ADD COLUMN IF NOT EXISTS response_payload jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ai_usage_events_client_request_key_hash_sha256'
      AND conrelid = 'public.ai_usage_events'::regclass
  ) THEN
    ALTER TABLE public.ai_usage_events
      ADD CONSTRAINT ai_usage_events_client_request_key_hash_sha256
      CHECK (
        client_request_key_hash IS NULL
        OR client_request_key_hash ~ '^[a-f0-9]{64}$'
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_events_user_feature_client_request_key_hash_idx
  ON public.ai_usage_events (user_id, feature, client_request_key_hash)
  WHERE client_request_key_hash IS NOT NULL;

COMMENT ON COLUMN public.ai_usage_events.client_request_key_hash IS
  'SHA-256 hash of a caller-provided paid AI action idempotency key. Raw keys are never stored.';

COMMENT ON COLUMN public.ai_usage_events.response_payload IS
  'Sanitized API response payload used to replay completed idempotent paid AI actions without charging again.';

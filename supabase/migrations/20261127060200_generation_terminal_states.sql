-- Generations that never end, and payments that credit nothing without anyone
-- being told (full audit 2026-11-27, finding 1 and the server lines of 14).
--
-- 1. The stalled-generation reaper takes the rows it tried least recently
--    first. Until now it took the ten oldest every tick, so ten rows that could
--    never resolve kept it from ever reaching a newer one. The reaper writes
--    this column at each attempt (src/lib/stalled-generation-reaper.ts). The
--    reaper's candidates are the few active rows, already narrowed by
--    idx_generations_status, so no index is added.
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS provider_sync_attempted_at timestamptz;

COMMENT ON COLUMN public.generations.provider_sync_attempted_at IS
  'When the stalled-generation reaper last asked the provider about this row; it takes the least recently tried first.';

-- 2. A failed (exhausted) output import is no longer reopened by a repeated
--    enqueue. Every status check that found the provider finished (the
--    reaper, a creator''s poll, a duplicate callback) called this, which put an
--    exhausted job straight back to pending with its old, past next_attempt_at:
--    one more doomed attempt on every tick, for ever. The import pipeline now
--    owns an exhausted job: it is reopened about once an hour while the
--    provider's file may still be there, and its generation is failed and
--    refunded when that window ends (src/lib/generation-output-import-retries.ts).
--    A repeated enqueue still refreshes the output URLs of an unfinished job,
--    and reopens a failed one at once when the URLs differ (a later callback
--    with a fresh render), without resetting its attempt count. Otherwise
--    unchanged from 20260810107000_durable_generation_output_imports.sql.
CREATE OR REPLACE FUNCTION public.enqueue_generation_output_import_job(
  p_generation_id uuid,
  p_output_urls jsonb,
  p_provider_completed_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_prediction_id text;
  v_job_id uuid;
BEGIN
  IF jsonb_typeof(p_output_urls) <> 'array'
     OR jsonb_array_length(p_output_urls) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_output_urls) AS item
       WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
     ) THEN
    RAISE EXCEPTION 'output_urls must contain between 1 and 8 non-empty strings';
  END IF;

  SELECT prediction_id INTO v_prediction_id
  FROM public.generations
  WHERE id = p_generation_id
  FOR UPDATE;

  IF v_prediction_id IS NULL THEN
    RAISE EXCEPTION 'generation % has no provider task id', p_generation_id;
  END IF;

  INSERT INTO public.generation_output_import_jobs (
    generation_id, prediction_id, output_urls, provider_completed_at,
    status, next_attempt_at, updated_at
  )
  VALUES (
    p_generation_id, v_prediction_id, p_output_urls, p_provider_completed_at,
    'pending', now(), now()
  )
  ON CONFLICT (generation_id) DO UPDATE SET
    output_urls = CASE
      WHEN public.generation_output_import_jobs.status = 'succeeded'
        THEN public.generation_output_import_jobs.output_urls
      ELSE excluded.output_urls
    END,
    provider_completed_at = coalesce(
      public.generation_output_import_jobs.provider_completed_at,
      excluded.provider_completed_at
    ),
    -- A failed job reopens only for different URLs (a later callback with a
    -- fresh render), keeping its attempt count: one more try, then the hourly
    -- retry again. The same URLs again leave it failed.
    status = CASE
      WHEN public.generation_output_import_jobs.status = 'failed'
          AND public.generation_output_import_jobs.output_urls IS DISTINCT FROM excluded.output_urls
        THEN 'pending'
      WHEN public.generation_output_import_jobs.status IN ('processing', 'succeeded', 'failed')
        THEN public.generation_output_import_jobs.status
      ELSE 'pending'
    END,
    next_attempt_at = CASE
      WHEN public.generation_output_import_jobs.status = 'failed'
          AND public.generation_output_import_jobs.output_urls IS DISTINCT FROM excluded.output_urls
        THEN now()
      WHEN public.generation_output_import_jobs.status IN ('processing', 'succeeded', 'failed')
        THEN public.generation_output_import_jobs.next_attempt_at
      ELSE least(public.generation_output_import_jobs.next_attempt_at, now())
    END,
    locked_at = CASE
      WHEN public.generation_output_import_jobs.status = 'processing'
        THEN public.generation_output_import_jobs.locked_at
      ELSE NULL
    END,
    locked_by = CASE
      WHEN public.generation_output_import_jobs.status = 'processing'
        THEN public.generation_output_import_jobs.locked_by
      ELSE NULL
    END,
    updated_at = now()
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_generation_output_import_job(uuid, jsonb, timestamptz) TO service_role;

-- 3. A reclaimed lease counts as an attempt. Only the finish function added to
--    attempt_count, so an import whose function was killed mid-run (past the
--    route's limit, or out of memory on a large video) went processing, lease
--    expired, reclaimed, killed again, for ever, and never reached failed:
--    nothing then owned it. Now each reclaim of an expired lease adds one, and
--    the reclaim that would use the last try (10, GENERATION_OUTPUT_IMPORT_MAX_
--    ATTEMPTS in src/lib/generation-output-import-jobs.ts) marks the job failed
--    instead, where the hourly retry and the 24-hour give-up own it. Otherwise
--    unchanged from 20260810107000.
CREATE OR REPLACE FUNCTION public.claim_generation_output_import_jobs(
  p_limit integer,
  p_locked_by text,
  p_lock_ttl_seconds integer DEFAULT 300
)
RETURNS SETOF public.generation_output_import_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF btrim(coalesce(p_locked_by, '')) = '' THEN RAISE EXCEPTION 'locked_by is required'; END IF;

  WITH crashed AS (
    SELECT id
    FROM public.generation_output_import_jobs
    WHERE status = 'processing'
      AND locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1))
      AND attempt_count + 1 >= 10
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_output_import_jobs AS jobs
  SET status = 'failed', attempt_count = attempt_count + 1,
      locked_at = NULL, locked_by = NULL,
      last_error = left('Import worker stopped before finishing (lease expired); last error: '
        || coalesce(jobs.last_error, 'none recorded'), 2000),
      completed_at = now(), updated_at = now()
  FROM crashed
  WHERE jobs.id = crashed.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM public.generation_output_import_jobs
    WHERE (status = 'pending' AND next_attempt_at <= now())
       OR (status = 'processing' AND locked_at <= now() - make_interval(secs => greatest(p_lock_ttl_seconds, 1)))
    ORDER BY next_attempt_at, created_at
    LIMIT least(greatest(p_limit, 1), 25)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.generation_output_import_jobs AS jobs
  SET status = 'processing',
      attempt_count = jobs.attempt_count + CASE WHEN jobs.status = 'processing' THEN 1 ELSE 0 END,
      locked_at = now(), locked_by = p_locked_by, updated_at = now()
  FROM candidates
  WHERE jobs.id = candidates.id
  RETURNING jobs.*;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_generation_output_import_jobs(integer, text, integer) TO service_role;

-- 4. A captured Razorpay payment that does not match its order (amount,
--    currency or buyer) credits nothing, and the webhook answers 200 so
--    Razorpay stops retrying. It was a log line only. It is recorded here and
--    reported on /api/ops/backend-alerts (src/lib/payment-capture-anomalies.ts),
--    not as backend health: the release gate needs health to be strictly ok,
--    and an anomaly the owner settles by hand in Razorpay must not freeze
--    releases. Append-only; one row per payment and reason, so Razorpay's
--    redeliveries do not multiply it.
CREATE TABLE IF NOT EXISTS public.payment_capture_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  payment_id text NOT NULL CHECK (btrim(payment_id) <> '' AND length(payment_id) <= 200),
  order_id text CHECK (order_id IS NULL OR length(order_id) <= 200),
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('credits', 'marketplace', 'post_resource', 'unknown')),
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_capture_anomalies_payment_reason_key UNIQUE (provider, payment_id, reason)
);

CREATE INDEX IF NOT EXISTS payment_capture_anomalies_created_at_idx
  ON public.payment_capture_anomalies (created_at);

ALTER TABLE public.payment_capture_anomalies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_capture_anomalies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.payment_capture_anomalies TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON public.payment_capture_anomalies FROM service_role;

-- Give provider failure rates a denominator.
--
-- provider_dependency_events persists a row only for failures and slow calls
-- (provider-fetch.ts), so any rate computed over it divides failures by
-- failures. The audit's F15a prescribes recording total attempt counts with a
-- counter rather than persisting a success row per call. This is that counter:
-- one row per (service, hour), incremented in place by every attempt.
--
-- Growth is bounded by time, not traffic: 24 rows per service per day,
-- roughly 44 KB a year for the current five services. Deliberately not wired
-- into the retention sweep yet — at that rate it does not earn a cron slot;
-- fold it into F7b's partition-and-retention work if it ever matters.

CREATE TABLE IF NOT EXISTS public.provider_fetch_attempt_counters (
  service_name text NOT NULL,
  bucket_start timestamptz NOT NULL,
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  PRIMARY KEY (service_name, bucket_start)
);

ALTER TABLE public.provider_fetch_attempt_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_fetch_attempt_counters FROM PUBLIC;
REVOKE ALL ON TABLE public.provider_fetch_attempt_counters FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provider_fetch_attempt_counters TO service_role;

-- One statement per attempt, so the hot path pays a single upsert against the
-- primary key. Contention concentrates on one row per service per hour, which
-- at provider-call volumes (network calls costing 100ms+ each) is noise.
CREATE OR REPLACE FUNCTION public.record_provider_fetch_attempt(p_service_name text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.provider_fetch_attempt_counters AS counters (
    service_name,
    bucket_start,
    attempt_count
  )
  VALUES (
    coalesce(nullif(btrim(p_service_name), ''), 'unknown'),
    date_trunc('hour', timezone('utc', now())),
    1
  )
  ON CONFLICT (service_name, bucket_start)
  DO UPDATE SET attempt_count = counters.attempt_count + 1;
$$;

REVOKE ALL ON FUNCTION public.record_provider_fetch_attempt(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_provider_fetch_attempt(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_provider_fetch_attempt(text) TO service_role;

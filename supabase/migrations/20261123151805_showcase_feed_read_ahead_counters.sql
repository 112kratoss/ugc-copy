-- Count Explore's read-ahead, so whether it pays for itself can be decided.
--
-- Each launch of the app asks the server to rank Explore's first page ahead
-- and hold it under a token (`readAhead=1`, `src/lib/showcase-feed-read-ahead.ts`):
-- a whole ranking plus a 100-300 KB data-cache write. The ranking pays off only
-- when Explore opens within 100 s and its read claims the token. Nothing kept
-- that rate: a held ranking leaves no row, request logs drop the query string
-- that tells a read-ahead apart, and backend_rate_limits rows (the read-ahead
-- shares the For you scope) are pruned within a few days.
--
-- One row per (event, hour), incremented in place, written after the response
-- (`src/lib/showcase-feed-read-ahead-counts.ts`):
--   hold        a ranking was held and its token handed to the app;
--   claim       a read handed a token back and was served the held ranking;
--   claim_miss  a read handed a token back and was served a ranking of its own
--               (the token expired, was spent, was never seen by this region,
--               or a session read within the window was reused instead).
-- A hold neither claimed nor missed is one whose Explore did not open in time.
--
-- Growth is bounded by time, not traffic: at most 72 rows a day. Not wired into
-- the retention sweep, like provider_fetch_attempt_counters; it goes with the
-- read-ahead's keep-or-drop decision.

CREATE TABLE IF NOT EXISTS public.showcase_feed_read_ahead_counters (
  event text NOT NULL CHECK (event IN ('hold', 'claim', 'claim_miss')),
  bucket_start timestamptz NOT NULL,
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  PRIMARY KEY (event, bucket_start)
);

ALTER TABLE public.showcase_feed_read_ahead_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.showcase_feed_read_ahead_counters FROM PUBLIC;
REVOKE ALL ON TABLE public.showcase_feed_read_ahead_counters FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.showcase_feed_read_ahead_counters TO service_role;

-- One upsert against the primary key per event. An event outside the three
-- fails the table's check rather than being stored under a name nobody reads.
CREATE OR REPLACE FUNCTION public.record_showcase_feed_read_ahead_event(p_event text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.showcase_feed_read_ahead_counters AS counters (
    event,
    bucket_start,
    event_count
  )
  VALUES (
    p_event,
    date_trunc('hour', now(), 'UTC'),
    1
  )
  ON CONFLICT (event, bucket_start)
  DO UPDATE SET event_count = counters.event_count + 1;
$$;

REVOKE ALL ON FUNCTION public.record_showcase_feed_read_ahead_event(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_showcase_feed_read_ahead_event(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_showcase_feed_read_ahead_event(text) TO service_role;

-- Give back one count check_backend_rate_limit made, in the window it was made in.
--
-- The showcase feed counts a signed-in read against its read limit beside admission's lifecycle
-- round trip (src/lib/showcase-feed-route-adapter-service.ts), so the count is already in when
-- admission refuses the read: a revoked or deleted session, a banned or merging account, or a
-- lifecycle check that is down. Without a refund such a read spends its account's budget: a
-- stolen token that a sign-out revoked could keep that account's feed on 429 until the token
-- expires, and an outage of the lifecycle check would leave every retrying client limited after
-- it recovers. The route gives the count back after answering, through this function.
--
-- The window is named by the caller (the check's own resetAt less its window), so a refund made
-- just after a window turns never takes a count from the next one. A count is never taken below
-- zero, and a window with nothing left to give answers false.

CREATE OR REPLACE FUNCTION public.refund_backend_rate_limit(
  p_scope text,
  p_subject_key text,
  p_window_start timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.backend_rate_limits
  SET request_count = request_count - 1,
      updated_at = pg_catalog.now()
  WHERE scope = pg_catalog.btrim(coalesce(p_scope, ''))
    AND subject_key = pg_catalog.btrim(coalesce(p_subject_key, ''))
    AND window_start = p_window_start
    AND request_count > 0;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_backend_rate_limit(text, text, timestamptz) TO service_role;

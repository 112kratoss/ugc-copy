-- Exact lifetime credit spend for the admin console.
--
-- The console computed this by selecting up to 10,000 `ai_usage_events` rows
-- and summing them in JavaScript. Past that cap the figure was silently wrong —
-- and silently wrong is the worst failure mode for a number an operator uses to
-- judge a refund or a goodwill grant. There was no indication of truncation.
--
-- Aggregating in Postgres removes both the cap and the row transfer.

CREATE OR REPLACE FUNCTION public.get_user_ai_usage_cost_total(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    -- Refunded events are excluded: the credits came back, so they were never
    -- spent. This matches what the settlement ledger considers consumed.
    'total_cost', coalesce(sum(usage.cost) FILTER (WHERE usage.refunded IS NOT TRUE), 0)::bigint,
    'event_count', count(*) FILTER (WHERE usage.refunded IS NOT TRUE)::bigint,
    'refunded_count', count(*) FILTER (WHERE usage.refunded IS TRUE)::bigint
  )
  FROM public.ai_usage_events AS usage
  WHERE usage.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.get_user_ai_usage_cost_total(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_ai_usage_cost_total(uuid)
  TO service_role;

COMMENT ON FUNCTION public.get_user_ai_usage_cost_total(uuid) IS
  'Service-role-only exact lifetime credit spend for one user, excluding refunded events.';

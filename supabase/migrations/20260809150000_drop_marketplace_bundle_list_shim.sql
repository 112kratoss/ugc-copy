-- F5b: remove the 6-argument `list_marketplace_resource_bundles` overload.
--
-- It is a back-compat shim that delegates to the 7-argument form with
-- `p_query => NULL`, and it has no callers: `post-resource-bundles-server.ts`
-- always supplies `p_query`, and nothing in the mobile app, the contracts or
-- the ops scripts references it.
--
-- Removing it is the same hazard F6 already hit and deliberately closed. Two
-- live overloads are unambiguous only while every caller uses named arguments
-- that match exactly one of them; a positional call, or a named call that
-- happens to supply the shared subset, matches both and PostgREST rejects it as
-- ambiguous rather than picking one. F6's note on
-- `list_showcase_top_sales_post_ids`: "PostgREST would match a four-argument
-- call against both functions and reject it as ambiguous."
--
-- Expect no measurable latency change. Per-call cost on this path is planning
-- plus a fixed PostgREST round-trip floor, not overload resolution -- see the
-- F5b section of docs/scaling-audit-2026-08-08.md. This is removing a footgun,
-- not tuning a hot path, and it should not be reported as a performance fix.

DROP FUNCTION IF EXISTS public.list_marketplace_resource_bundles(
  text,    -- p_access_filter
  text,    -- p_resource_filter
  text,    -- p_tool_slug
  text,    -- p_sort
  integer, -- p_offset
  integer  -- p_limit
);

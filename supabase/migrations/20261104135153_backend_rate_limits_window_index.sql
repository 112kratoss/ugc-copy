-- backend_rate_limits had only its primary key, (scope, subject_key,
-- window_start). Its two whole-table readers lead with window_start instead:
--
-- * the operational-retention prune (prune_operational_backend_data,
--   20261010071057) takes `window_start < cutoff ORDER BY window_start, scope,
--   subject_key LIMIT n FOR UPDATE SKIP LOCKED`, and
-- * the cost report's 24-hour aggregate (get_backend_cost_aggregates,
--   20260809200000) reads `window_start >= p_since`.
--
-- Both scanned the whole table. This index is in the prune's order, so its
-- LIMIT stops after the batch and needs no sort, and its leading column bounds
-- the aggregate's range. The per-request cleanup in check_backend_rate_limit
-- keys on (scope, subject_key) and keeps using the primary key. window_start
-- is never updated (a hit moves request_count and updated_at only), so the
-- upserts keep their heap-only updates.
--
-- The build reads the table once under a SHARE lock, which holds rate-limit
-- writes back for that long (the table is a few thousand rows: milliseconds),
-- and waits at most five seconds for the lock itself, as 20261103232038 means
-- to. That migration's SET LOCAL is a no-op wherever the file is not run
-- inside a transaction block: `supabase db reset` applies statements outside
-- one and warns "SET LOCAL can only be used in transaction blocks". A plain
-- SET, reset at the end, holds either way, and a failed transaction reverts it.
SET lock_timeout = '5s';

CREATE INDEX backend_rate_limits_window_start_idx
  ON public.backend_rate_limits (window_start, scope, subject_key);

RESET lock_timeout;

COMMENT ON INDEX public.backend_rate_limits_window_start_idx IS
  'Serves the retention prune (window_start < cutoff, in this order) and the cost report''s window_start >= since aggregate, which both scanned the table.';

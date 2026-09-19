-- Fleet playback metrics from the mobile app (delivery plan
-- docs/plans/social-media-delivery-final-plan-2026-09-19.md, step 7). Each
-- phone aggregates its own session — start-up times as a bounded reservoir of
-- samples plus totals, stalls as counters — and posts it a few times per
-- session through /api/mobile/playback-metrics, which stores one row per
-- surface and start kind. Rows carry no user, medium or address: a random
-- session id, the app version, the platform, the OS, the network kind and the
-- numbers. At a few rows per session the table stays small; nothing else
-- reads it but the daily view below.

CREATE TABLE IF NOT EXISTS public.playback_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9-]{8,40}$'),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  os_version text NOT NULL CHECK (char_length(os_version) BETWEEN 1 AND 16),
  device_model text CHECK (device_model IS NULL OR char_length(device_model) BETWEEN 1 AND 40),
  network text NOT NULL CHECK (network IN ('wifi', 'cellular', 'none', 'other', 'unknown')),
  app_version text CHECK (app_version IS NULL OR char_length(app_version) BETWEEN 1 AND 32),
  app_build text CHECK (app_build IS NULL OR char_length(app_build) BETWEEN 1 AND 32),
  app_update text CHECK (app_update IS NULL OR char_length(app_update) BETWEEN 1 AND 32),
  -- Milliseconds of the session the report covered.
  span_ms integer NOT NULL CHECK (span_ms >= 0),
  surface text NOT NULL CHECK (surface IN ('feed', 'viewer')),
  -- cold: the player had no frame when asked to play; warm: it had one (prepared, lent).
  start_kind text NOT NULL CHECK (start_kind IN ('cold', 'warm')),
  starts integer NOT NULL CHECK (starts >= 0),
  start_total_ms bigint NOT NULL CHECK (start_total_ms >= 0),
  start_max_ms integer NOT NULL CHECK (start_max_ms >= 0),
  -- Reservoir-sampled start times, at most 32, for percentiles.
  start_samples integer[] NOT NULL DEFAULT '{}' CHECK (cardinality(start_samples) <= 32),
  stalls integer NOT NULL CHECK (stalls >= 0),
  stall_total_ms bigint NOT NULL CHECK (stall_total_ms >= 0),
  stall_max_ms integer NOT NULL CHECK (stall_max_ms >= 0)
);

CREATE INDEX IF NOT EXISTS playback_metrics_received_idx
  ON public.playback_metrics (received_at);

ALTER TABLE public.playback_metrics ENABLE ROW LEVEL SECURITY;

-- The route writes with the service role; nothing signed in reads or writes it.
REVOKE ALL ON TABLE public.playback_metrics FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.playback_metrics TO service_role;

COMMENT ON TABLE public.playback_metrics IS
  'Per-session video start-up and stall aggregates posted by the mobile app; one row per surface and start kind. Anonymous: no user, medium or address.';

-- Day by day, per platform, surface and start kind: sessions, starts, start
-- percentiles from the pooled samples, stall counts and stall time. Percentiles
-- are of the reservoir, so each session contributes at most 32 samples and a
-- long session cannot swamp a short one.
CREATE OR REPLACE VIEW public.playback_metrics_daily
WITH (security_invoker = true)
AS
WITH samples AS (
  SELECT
    date_trunc('day', received_at) AS day,
    platform,
    network,
    surface,
    start_kind,
    unnest(start_samples) AS start_ms
  FROM public.playback_metrics
),
percentiles AS (
  SELECT
    day, platform, network, surface, start_kind,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY start_ms) AS start_p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY start_ms) AS start_p95_ms
  FROM samples
  GROUP BY day, platform, network, surface, start_kind
)
SELECT
  date_trunc('day', m.received_at) AS day,
  m.platform,
  m.network,
  m.surface,
  m.start_kind,
  count(DISTINCT m.session_id) AS sessions,
  sum(m.starts) AS starts,
  round(sum(m.start_total_ms)::numeric / nullif(sum(m.starts), 0), 1) AS start_mean_ms,
  max(m.start_max_ms) AS start_max_ms,
  p.start_p50_ms,
  p.start_p95_ms,
  sum(m.stalls) AS stalls,
  round(sum(m.stalls)::numeric / nullif(sum(m.starts), 0), 4) AS stalls_per_start,
  sum(m.stall_total_ms) AS stall_total_ms,
  max(m.stall_max_ms) AS stall_max_ms
FROM public.playback_metrics AS m
LEFT JOIN percentiles AS p
  ON p.day = date_trunc('day', m.received_at)
 AND p.platform = m.platform
 AND p.network = m.network
 AND p.surface = m.surface
 AND p.start_kind = m.start_kind
GROUP BY date_trunc('day', m.received_at), m.platform, m.network, m.surface, m.start_kind, p.start_p50_ms, p.start_p95_ms;

REVOKE ALL ON public.playback_metrics_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.playback_metrics_daily TO service_role;

COMMENT ON VIEW public.playback_metrics_daily IS
  'Daily video start-up percentiles and stall rates per platform, network, surface and start kind, from playback_metrics.';

-- Continuation pages load one existing delivery fact as the session template.
-- The facts deliberately have no FK to ephemeral feed_sessions, so no FK
-- advisor caught this missing access-path index. On 2026-09-21 a missing-session
-- lookup scanned 32,946 production rows / 3,165 shared buffers (1.62 seconds).
-- Keep this narrow: session dimensions are immutable and LIMIT 1 needs only
-- one heap row, not a covering copy of the full telemetry payload.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS feed_delivery_facts_session_idx
  ON public.feed_delivery_facts (session_id);

-- Scope the upload-reclaim SLO to work the sweep is actually allowed to drain.
--
-- `get_upload_reclaim_health` fed two wrong numbers into
-- `upload-capacity-health.ts`, and together they made a single abandoned upload
-- read as a production incident that could never clear:
--
--   1. `oldest_actionable_at` was `min(expires_at)` -- the moment the *signed
--      URL* expired, which is two hours after the object was staged.
--      A never-consumed reservation is deferred until `reclaim_after`, which
--      `RECLAIM_AFTER_HOURS` puts 48 hours past finalization, so every such row
--      enters the actionable set already ~46 hours old by that clock and
--      crosses the 48-hour degraded threshold about two hours later. The
--      `media-upload-reclaim` job runs daily, so the row was reported as an
--      undrained backlog roughly 22 hours before the sweep could first look at
--      it. Ageing from the instant the row actually became actionable --
--      `greatest(expires_at, reclaim_after)` -- measures the thing the SLO
--      claims to measure: how long eligible work has gone unreclaimed.
--
--   2. The actionable set counted never-consumed reservations even while
--      `MEDIA_UPLOAD_RECLAIM_ABANDONED` withholds exactly those rows from the
--      sweep (see media-upload-reclaim-service.ts). Health was measuring a
--      queue with no consumer, so the breach was unfixable by design: no run of
--      the job could ever lower the number. `p_include_abandoned` lets the
--      caller pass the rollout gate down, and the withheld rows are counted
--      separately so a deliberate hold stays visible as a hold rather than
--      disappearing or paging.
--
-- Recorded because it fired: incident issue #78, degraded from 2026-08-25
-- 08:20 UTC on one reservation staged two days earlier.

-- The return type gains columns, so the old signature has to go first;
-- CREATE OR REPLACE cannot widen it.
DROP FUNCTION IF EXISTS public.get_upload_reclaim_health(timestamptz);

CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health(
  p_now timestamptz DEFAULT now(),
  -- Defaulted so a deploy that applies migrations before promoting the build
  -- keeps working against the previous release, which passes only p_now.
  p_include_abandoned boolean DEFAULT true
)
RETURNS TABLE (
  actionable_rows bigint,
  actionable_rows_capped boolean,
  deferred_rows bigint,
  deferred_rows_capped boolean,
  withheld_rows bigint,
  withheld_rows_capped boolean,
  oldest_actionable_at timestamptz,
  oldest_deferred_at timestamptz,
  outstanding_bytes bigint,
  tombstone_rows bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  WITH actionable AS MATERIALIZED (
    SELECT
      greatest(
        reservation.expires_at,
        coalesce(reservation.reclaim_after, reservation.expires_at)
      ) AS actionable_at
    FROM public.upload_byte_reservations AS reservation
    WHERE reservation.released_at IS NULL
      AND reservation.expires_at <= p_now
      AND (reservation.reclaim_after IS NULL OR reservation.reclaim_after <= p_now)
      -- The sweep only offers never-consumed rows once the rollout gate is
      -- effective. Counting them regardless reports a hold as a backlog.
      AND (p_include_abandoned OR reservation.consumed_at IS NOT NULL)
      AND reservation.finalization_status IN (
        'reserved', 'issued', 'finalizing', 'finalized',
        'consuming', 'consumed', 'deleted', 'reclaiming'
      )
    ORDER BY greatest(
      reservation.expires_at,
      coalesce(reservation.reclaim_after, reservation.expires_at)
    ), reservation.id
    LIMIT 20001
  ), withheld AS MATERIALIZED (
    SELECT reservation.id
    FROM public.upload_byte_reservations AS reservation
    WHERE NOT p_include_abandoned
      AND reservation.released_at IS NULL
      AND reservation.expires_at <= p_now
      AND (reservation.reclaim_after IS NULL OR reservation.reclaim_after <= p_now)
      AND reservation.consumed_at IS NULL
      AND reservation.finalization_status IN (
        'reserved', 'issued', 'finalizing', 'finalized',
        'consuming', 'consumed', 'deleted', 'reclaiming'
      )
    ORDER BY reservation.expires_at, reservation.id
    LIMIT 20001
  ), deferred AS MATERIALIZED (
    SELECT reservation.reclaim_after
    FROM public.upload_byte_reservations AS reservation
    WHERE reservation.released_at IS NULL
      AND reservation.expires_at <= p_now
      AND reservation.reclaim_after > p_now
      AND reservation.finalization_status IN (
        'reserved', 'issued', 'finalizing', 'finalized',
        'consuming', 'consumed', 'deleted', 'reclaiming'
      )
    ORDER BY reservation.reclaim_after, reservation.id
    LIMIT 20001
  ), health AS (
    SELECT
      (SELECT count(*) FROM actionable) AS actionable_count,
      (SELECT count(*) FROM withheld) AS withheld_count,
      (SELECT count(*) FROM deferred) AS deferred_count
  )
  SELECT
    least(health.actionable_count, 20000)::bigint,
    health.actionable_count > 20000,
    least(health.deferred_count, 20000)::bigint,
    health.deferred_count > 20000,
    least(health.withheld_count, 20000)::bigint,
    health.withheld_count > 20000,
    (SELECT min(actionable.actionable_at) FROM actionable),
    (SELECT min(deferred.reclaim_after) FROM deferred),
    coalesce((
      SELECT counter.outstanding_bytes
      FROM public.upload_byte_global_counters AS counter
      WHERE counter.singleton = true
    ), 0)::bigint,
    coalesce((
      SELECT stats.n_live_tup
      FROM pg_catalog.pg_stat_user_tables AS stats
      WHERE stats.schemaname = 'public'
        AND stats.relname = 'upload_path_tombstones'
    ), 0)::bigint
  FROM health;
$$;

REVOKE ALL ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_upload_reclaim_health(timestamptz, boolean)
  TO service_role;

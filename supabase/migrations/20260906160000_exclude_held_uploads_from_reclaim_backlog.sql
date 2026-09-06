-- Stop reporting a deliberately-held upload as an undrained backlog.
--
-- This is incident #78 again, reaching the SLO through a different hold. The
-- 20260825120000 migration taught `get_upload_reclaim_health` about the
-- *rollout* hold (`MEDIA_UPLOAD_RECLAIM_ABANDONED`) and aged rows from
-- `greatest(expires_at, reclaim_after)` instead of from expiry. It did not
-- teach it about the other hold, which lives entirely in application code:
-- `loadProtectedMobileUploadKeys` in src/lib/upload-finalization.ts refuses to
-- reclaim an `uploads` row while its `media_upload_intents` row still has
-- `storage_cleared_at IS NULL`, because that upload is a live draft.
--
-- That hold writes nothing to the reservation -- no `reclaim_after`, no status
-- change -- so the health RPC had no way to see it. The sweep preserves the row
-- (returning it to `consumed`), health counts it as actionable the whole time,
-- and `oldest_actionable_at` keeps ageing from expiry. The result is the same
-- unfixable breach the previous migration set out to remove: a queue with no
-- consumer, which no run of the job can lower.
--
-- Recorded because it fired: watchdog 503 hourly from 2026-09-04 ~13:50 UTC on
-- one 227 KB draft staged 2026-09-03, held until `media-upload-reclaim` cleared
-- its object at 2026-09-06 00:10 UTC. Every sweep in between reported zero
-- failures, because a hold and a release both scored as `handled`.

-- The predicate the sweep applies, expressed once so both the actionable and
-- the withheld sets ask exactly the same question. Kept in step with
-- `loadProtectedMobileUploadKeys`: if that function's rule changes, this
-- changes with it or health starts lying again.
CREATE OR REPLACE FUNCTION public.upload_reservation_intent_held(
  p_bucket_id text,
  p_user_id uuid,
  p_storage_path text,
  p_finalization_status text,
  p_consumption_disposition text,
  p_consumed_at timestamptz,
  p_client_finalized_at timestamptz,
  p_now timestamptz,
  p_include_abandoned boolean
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT
    -- Only staging uploads carry an intent; every other bucket is unheld.
    p_bucket_id = 'uploads'
    -- An explicit delete request overrides the draft hold in the sweep, so it
    -- must override it here too.
    AND p_finalization_status <> 'deleted'
    AND p_consumption_disposition IS DISTINCT FROM 'delete'
    -- `mayReclaimExplicitAbandon`: an explicitly-finalized draft stops being
    -- protected once it has been abandoned for RECLAIM_AFTER_HOURS (48).
    AND NOT (
      p_consumed_at IS NULL
      AND p_client_finalized_at IS NOT NULL
      AND p_client_finalized_at <= p_now - interval '48 hours'
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public.media_upload_intents AS intent
        WHERE intent.user_id = p_user_id
          AND intent.storage_path = p_storage_path
          AND intent.storage_cleared_at IS NULL
      )
      -- The legacy fail-closed arm: while the rollout gate is ineffective, a
      -- missing intent is ambiguous rather than absent, and the sweep holds the
      -- row instead of reclaiming it.
      OR (
        NOT p_include_abandoned
        AND NOT EXISTS (
          SELECT 1
          FROM public.media_upload_intents AS intent
          WHERE intent.user_id = p_user_id
            AND intent.storage_path = p_storage_path
        )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.upload_reservation_intent_held(
  text, uuid, text, text, text, timestamptz, timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upload_reservation_intent_held(
  text, uuid, text, text, text, timestamptz, timestamptz, timestamptz, boolean
) TO service_role;

-- The output columns are unchanged, so this replaces in place; no DROP, and no
-- mid-deploy signature gap for the build that is still calling the old body.
CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health(
  p_now timestamptz DEFAULT now(),
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
      -- Nor may a live draft count as backlog: the sweep preserves it on
      -- purpose, so no run can drain it while the hold stands.
      AND NOT public.upload_reservation_intent_held(
        reservation.bucket_id,
        reservation.user_id,
        reservation.storage_path,
        reservation.finalization_status,
        reservation.consumption_disposition,
        reservation.consumed_at,
        reservation.client_finalized_at,
        p_now,
        p_include_abandoned
      )
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
    WHERE reservation.released_at IS NULL
      AND reservation.expires_at <= p_now
      AND (reservation.reclaim_after IS NULL OR reservation.reclaim_after <= p_now)
      AND reservation.finalization_status IN (
        'reserved', 'issued', 'finalizing', 'finalized',
        'consuming', 'consumed', 'deleted', 'reclaiming'
      )
      -- Both holds land here, so a deliberate hold stays visible as a hold
      -- rather than disappearing from the report entirely.
      AND (
        (NOT p_include_abandoned AND reservation.consumed_at IS NULL)
        OR public.upload_reservation_intent_held(
          reservation.bucket_id,
          reservation.user_id,
          reservation.storage_path,
          reservation.finalization_status,
          reservation.consumption_disposition,
          reservation.consumed_at,
          reservation.client_finalized_at,
          p_now,
          p_include_abandoned
        )
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

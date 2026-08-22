-- Make post-certificate durable state visible and give merge tickets bounded
-- retention. Workflow/template runs remain user history and are reported, not
-- deleted. Upload path tombstones remain a permanent replay-prevention ledger.

CREATE INDEX IF NOT EXISTS account_merge_tickets_retention_expiry_idx
  ON public.account_merge_tickets (expires_at, id);

CREATE OR REPLACE FUNCTION public.prune_account_merge_tickets(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT ticket.id
    FROM public.account_merge_tickets AS ticket
    -- Keep every ticket for thirty days beyond its redemption lifetime. This
    -- preserves retry/forensic evidence without retaining hashes forever.
    WHERE ticket.expires_at < now() - interval '30 days'
    ORDER BY ticket.expires_at, ticket.id
    LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.account_merge_tickets AS ticket
  USING victims
  WHERE ticket.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_account_merge_tickets(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_account_merge_tickets(integer)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health(
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  actionable_rows bigint,
  actionable_rows_capped boolean,
  deferred_rows bigint,
  deferred_rows_capped boolean,
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
    SELECT reservation.expires_at
    FROM public.upload_byte_reservations AS reservation
    WHERE reservation.released_at IS NULL
      AND reservation.expires_at <= p_now
      AND (reservation.reclaim_after IS NULL OR reservation.reclaim_after <= p_now)
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
      (SELECT count(*) FROM deferred) AS deferred_count
  )
  SELECT
    least(health.actionable_count, 20000)::bigint,
    health.actionable_count > 20000,
    least(health.deferred_count, 20000)::bigint,
    health.deferred_count > 20000,
    (SELECT min(actionable.expires_at) FROM actionable),
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

REVOKE ALL ON FUNCTION public.get_upload_reclaim_health(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_upload_reclaim_health(timestamptz)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_operational_table_growth()
RETURNS TABLE (
  table_name text,
  live_rows bigint,
  total_bytes bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $function$
  SELECT
    stats.relname::text AS table_name,
    stats.n_live_tup AS live_rows,
    pg_catalog.pg_total_relation_size(stats.relid) AS total_bytes
  FROM pg_catalog.pg_stat_user_tables AS stats
  WHERE stats.schemaname = 'public'
    AND stats.relname = ANY (ARRAY[
      'account_merge_tickets',
      'backend_job_runs',
      'backend_rate_limits',
      'feed_delivery_facts',
      'feed_events',
      'feed_session_items',
      'feed_sessions',
      'generation_completion_jobs',
      'generation_model_provider_checks',
      'provider_dependency_events',
      'template_run_steps',
      'template_runs',
      'upload_byte_reservations',
      'upload_byte_user_counters',
      'upload_path_tombstones',
      'workflow_canvas_run_steps',
      'workflow_canvas_runs',
      'workflow_run_step_jobs'
    ])
  ORDER BY pg_catalog.pg_total_relation_size(stats.relid) DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()
  TO service_role;

COMMENT ON FUNCTION public.get_upload_reclaim_health(timestamptz) IS
  'Upload reclaim backlog, deferred population, outstanding admission bytes, and permanent tombstone count. Service role only.';
COMMENT ON FUNCTION public.get_operational_table_growth() IS
  'Row counts and byte sizes for churn-prone operational state, permanent security ledgers, and user-owned workflow history. Service role only.';

-- Bound auxiliary retention work so one daily maintenance invocation cannot
-- turn a large backlog into an unbounded lock/WAL transaction.

CREATE INDEX IF NOT EXISTS post_share_events_retention_idx
  ON public.post_share_events (created_at, id);
CREATE INDEX IF NOT EXISTS profile_share_events_retention_idx
  ON public.profile_share_events (created_at, id);
CREATE INDEX IF NOT EXISTS free_unlock_orders_retention_idx
  ON public.post_resource_bundle_orders (created_at, id)
  WHERE status = 'created' AND amount_subunits = 0;
CREATE INDEX IF NOT EXISTS mobile_notifications_read_retention_idx
  ON public.mobile_notifications (updated_at, id)
  WHERE is_read = true;

CREATE OR REPLACE FUNCTION public.prune_post_share_events(
  p_older_than interval DEFAULT interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT id FROM public.post_share_events
    WHERE created_at < timezone('utc'::text, now()) - p_older_than
    ORDER BY created_at, id LIMIT 5000
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.post_share_events AS events
  USING victims WHERE events.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_profile_share_events(
  p_older_than interval DEFAULT interval '90 days'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT id FROM public.profile_share_events
    WHERE created_at < timezone('utc'::text, now()) - p_older_than
    ORDER BY created_at, id LIMIT 5000
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.profile_share_events AS events
  USING victims WHERE events.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_abandoned_free_unlock_orders(
  p_older_than interval DEFAULT interval '1 day'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT orders.id
    FROM public.post_resource_bundle_orders AS orders
    WHERE orders.status = 'created'
      AND orders.amount_subunits = 0
      AND orders.razorpay_order_id LIKE 'free_bundle_%'
      AND orders.created_at < timezone('utc'::text, now()) - p_older_than
      AND NOT EXISTS (
        SELECT 1 FROM public.post_resource_bundle_purchases AS purchases
        WHERE purchases.order_id = orders.id
      )
    ORDER BY orders.created_at, orders.id LIMIT 5000
    FOR UPDATE OF orders SKIP LOCKED
  )
  DELETE FROM public.post_resource_bundle_orders AS orders
  USING victims WHERE orders.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_upload_byte_reservations(
  p_limit integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_deleted integer;
BEGIN
  WITH victims AS (
    SELECT id FROM public.upload_byte_reservations
    WHERE expires_at <= now() OR released_at < now() - interval '1 day'
    ORDER BY expires_at, id LIMIT greatest(1, least(coalesce(p_limit, 5000), 50000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.upload_byte_reservations AS reservations
  USING victims WHERE reservations.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_mobile_notification_retention(
  p_delivery_cutoff timestamptz,
  p_notification_cutoff timestamptz,
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 50000));
  v_deliveries integer;
  v_notifications integer;
BEGIN
  WITH victims AS (
    SELECT id FROM public.mobile_push_deliveries
    WHERE created_at < p_delivery_cutoff
    ORDER BY created_at, id LIMIT v_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.mobile_push_deliveries AS deliveries
  USING victims WHERE deliveries.id = victims.id;
  GET DIAGNOSTICS v_deliveries = ROW_COUNT;

  WITH victims AS (
    SELECT id FROM public.mobile_notifications
    WHERE is_read = true AND updated_at < p_notification_cutoff
    ORDER BY updated_at, id LIMIT v_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.mobile_notifications AS notifications
  USING victims WHERE notifications.id = victims.id;
  GET DIAGNOSTICS v_notifications = ROW_COUNT;

  RETURN jsonb_build_object(
    'deliveriesDeleted', v_deliveries,
    'notificationsDeleted', v_notifications,
    'batchLimitReached', v_deliveries = v_limit OR v_notifications = v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_upload_byte_reservations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_upload_byte_reservations(integer) TO service_role;
REVOKE ALL ON FUNCTION public.prune_mobile_notification_retention(timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_mobile_notification_retention(timestamptz, timestamptz, integer)
  TO service_role;


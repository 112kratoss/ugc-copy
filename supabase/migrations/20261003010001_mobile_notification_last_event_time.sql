-- An alert's place and age in the inbox follow its last event: its arrival, or
-- the latest event grouped into it.
--
-- Both were read from updated_at, which mobile_notifications_set_updated_at
-- stamps on every write to the row. Marking an alert read is a write, so a
-- read alert moved to the top of the inbox aged "Just now", and "Mark all read"
-- gave every alert the same time. The write that records a push ticket on the
-- alert stamped it too.
--
-- last_event_at is written only when an alert arrives and when
-- upsert_mobile_notification groups another event into it. updated_at keeps
-- recording every write, and read-alert retention keeps counting from it.

ALTER TABLE public.mobile_notifications
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

-- Existing alerts. A single alert's last event is its arrival. A grouped
-- alert's events all fall inside one 15-minute window (the window is part of
-- its aggregation key), so an updated_at later than that is a read or a push
-- ticket, not an event.
--
-- The trigger is set aside for the repair: left on, it would stamp updated_at
-- on every alert, and the inbox reads updated_at until the server that reads
-- last_event_at is live. One statement, so a failed repair cannot leave the
-- trigger off.
DO $$
BEGIN
  ALTER TABLE public.mobile_notifications DISABLE TRIGGER mobile_notifications_set_updated_at;

  UPDATE public.mobile_notifications
  SET last_event_at = CASE
    WHEN event_count > 1 THEN least(updated_at, created_at + interval '15 minutes')
    ELSE created_at
  END
  WHERE last_event_at IS NULL;

  ALTER TABLE public.mobile_notifications ENABLE TRIGGER mobile_notifications_set_updated_at;
END;
$$;

ALTER TABLE public.mobile_notifications
  ALTER COLUMN last_event_at SET DEFAULT timezone('utc'::text, now()),
  ALTER COLUMN last_event_at SET NOT NULL;

COMMENT ON COLUMN public.mobile_notifications.last_event_at IS
  'When the alert arrived, or when the latest event was grouped into it. The inbox is ordered by it and shows it as the alert''s age. Reading the alert does not change it; updated_at records every write.';

-- The inbox is ordered by last_event_at now, and nothing else read the old order.
DROP INDEX IF EXISTS public.mobile_notifications_user_updated_idx;
CREATE INDEX IF NOT EXISTS mobile_notifications_user_last_event_idx
  ON public.mobile_notifications (user_id, last_event_at DESC, id DESC);

-- The same function, with one line added: an event that joins a group is the
-- group's last event.
CREATE OR REPLACE FUNCTION public.upsert_mobile_notification(
  p_user_id uuid,
  p_actor_user_id uuid,
  p_type text,
  p_category text,
  p_title text,
  p_body text,
  p_deep_link text DEFAULT NULL,
  p_object_type text DEFAULT NULL,
  p_object_id text DEFAULT NULL,
  p_dedupe_key text DEFAULT NULL,
  p_aggregation_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.mobile_notifications%ROWTYPE;
  v_was_created boolean := true;
BEGIN
  IF p_aggregation_key IS NULL OR length(trim(p_aggregation_key)) = 0 THEN
    RAISE EXCEPTION 'aggregation key is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mobile_notifications (
    user_id,
    actor_user_id,
    type,
    category,
    title,
    body,
    deep_link,
    object_type,
    object_id,
    dedupe_key,
    aggregation_key,
    event_count,
    is_read
  )
  VALUES (
    p_user_id,
    p_actor_user_id,
    p_type,
    p_category,
    p_title,
    p_body,
    p_deep_link,
    p_object_type,
    p_object_id,
    p_dedupe_key,
    p_aggregation_key,
    1,
    false
  )
  ON CONFLICT (user_id, aggregation_key)
    WHERE aggregation_key IS NOT NULL
  DO UPDATE SET
    actor_user_id = EXCLUDED.actor_user_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    deep_link = EXCLUDED.deep_link,
    object_type = EXCLUDED.object_type,
    object_id = EXCLUDED.object_id,
    event_count = public.mobile_notifications.event_count + 1,
    is_read = false,
    last_event_at = timezone('utc'::text, now()),
    updated_at = timezone('utc'::text, now())
  RETURNING * INTO v_row;

  v_was_created := v_row.event_count = 1;

  RETURN jsonb_build_object(
    'notification', to_jsonb(v_row),
    'wasCreated', v_was_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_mobile_notification(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_mobile_notification(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO service_role;

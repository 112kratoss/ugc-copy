-- Save alerts that name whoever saved ("@maya saved your post"), as reviewed.
--
-- 1. Told, on record. profiles.saver_notice_seen_at is when the account was
--    first told "Creators can see who saved their posts." It is written by
--    POST /api/profile/saver-notice once the notice has been read, on any
--    device, and the save service names a saver only once it is set.
-- 2. A named save alert follows its save. create_post_save_alert writes one
--    only while the save stands, and withdraw_post_save_alert takes it back
--    only once the save is gone. Both hold the lock set_post_save_state takes
--    for that saver and post, so an unsave answered before the save's alert
--    was written can no longer leave the alert behind, and a late take-back
--    can no longer remove the alert of a save made again.
-- 3. Taken back, not deleted. withdrawn_at hides an alert from its owner's
--    inbox while its push deliveries stay, so their receipts still retire
--    dead tokens; retention deletes withdrawn alerts once their deliveries
--    are gone. A save made again brings the same alert back as new.
-- 4. A block between two accounts takes back the save alerts that name either
--    of them to the other (withdraw_post_save_alerts_between).
-- 5. Anonymous alerts keep no one. Grouped "Someone saved your post" and
--    "Someone shared your post" rows stop storing the latest actor, and the
--    actor is cleared from the ones already written.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS saver_notice_seen_at timestamptz;

COMMENT ON COLUMN public.profiles.saver_notice_seen_at IS
  'When the account was first told that creators can see who saved their posts. Save alerts name a saver only once it is set.';

ALTER TABLE public.mobile_notifications
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;

COMMENT ON COLUMN public.mobile_notifications.withdrawn_at IS
  'When the alert was taken back (a named save that was unsaved, or a block between the two accounts). The inbox hides it; retention deletes it with its push deliveries.';

CREATE INDEX IF NOT EXISTS mobile_notifications_withdrawn_retention_idx
  ON public.mobile_notifications (withdrawn_at, id)
  WHERE withdrawn_at IS NOT NULL;

-- The inbox filters on it, and a filtered column needs the read grant.
GRANT SELECT (withdrawn_at) ON TABLE public.mobile_notifications TO authenticated;

CREATE OR REPLACE FUNCTION public.create_post_save_alert(
  p_recipient_user_id uuid,
  p_actor_user_id uuid,
  p_post_id uuid,
  p_title text,
  p_body text,
  p_deep_link text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_dedupe_key text := 'post-save:' || p_actor_user_id::text || ':' || p_post_id::text;
  v_row public.mobile_notifications%ROWTYPE;
BEGIN
  IF p_recipient_user_id IS NULL OR p_actor_user_id IS NULL OR p_post_id IS NULL
    OR p_recipient_user_id = p_actor_user_id THEN
    RETURN jsonb_build_object('created', false);
  END IF;

  -- The lock set_post_save_state holds while it saves or unsaves this post
  -- for this saver: the save below is read as it stands.
  PERFORM pg_advisory_xact_lock(hashtextextended('post-save:' || p_actor_user_id::text || ':' || p_post_id::text, 0));

  IF NOT EXISTS (
    SELECT 1 FROM public.post_saves
    WHERE user_id = p_actor_user_id AND post_id = p_post_id
  ) THEN
    RETURN jsonb_build_object('created', false);
  END IF;

  INSERT INTO public.mobile_notifications (
    user_id, actor_user_id, type, category, title, body, deep_link,
    object_type, object_id, dedupe_key
  )
  VALUES (
    p_recipient_user_id, p_actor_user_id, 'post_saved', 'social', p_title, p_body, p_deep_link,
    'post', p_post_id::text, v_dedupe_key
  )
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE
    SET withdrawn_at = NULL,
        title = EXCLUDED.title,
        body = EXCLUDED.body,
        deep_link = EXCLUDED.deep_link,
        is_read = false,
        event_count = 1,
        created_at = timezone('utc'::text, now()),
        last_event_at = timezone('utc'::text, now())
    WHERE public.mobile_notifications.withdrawn_at IS NOT NULL
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('created', true, 'notification', to_jsonb(v_row));
  END IF;

  -- Saved again while its alert still stood: nothing new to tell.
  SELECT * INTO v_row FROM public.mobile_notifications
  WHERE user_id = p_recipient_user_id AND dedupe_key = v_dedupe_key;
  RETURN jsonb_build_object('created', false, 'notification', to_jsonb(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_post_save_alert(
  p_recipient_user_id uuid,
  p_actor_user_id uuid,
  p_post_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_withdrawn integer;
BEGIN
  IF p_recipient_user_id IS NULL OR p_actor_user_id IS NULL OR p_post_id IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('post-save:' || p_actor_user_id::text || ':' || p_post_id::text, 0));

  -- Saved again before this ran: the alert is that save's now.
  IF EXISTS (
    SELECT 1 FROM public.post_saves
    WHERE user_id = p_actor_user_id AND post_id = p_post_id
  ) THEN
    RETURN 0;
  END IF;

  UPDATE public.mobile_notifications
  SET withdrawn_at = timezone('utc'::text, now())
  WHERE user_id = p_recipient_user_id
    AND dedupe_key = 'post-save:' || p_actor_user_id::text || ':' || p_post_id::text
    AND withdrawn_at IS NULL;
  GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  RETURN v_withdrawn;
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_post_save_alerts_between(
  p_first_user_id uuid,
  p_second_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_withdrawn integer;
BEGIN
  IF p_first_user_id IS NULL OR p_second_user_id IS NULL OR p_first_user_id = p_second_user_id THEN
    RETURN 0;
  END IF;

  UPDATE public.mobile_notifications
  SET withdrawn_at = timezone('utc'::text, now())
  WHERE withdrawn_at IS NULL
    AND type = 'post_saved'
    AND (
      (user_id = p_first_user_id AND dedupe_key LIKE 'post-save:' || p_second_user_id::text || ':%')
      OR (user_id = p_second_user_id AND dedupe_key LIKE 'post-save:' || p_first_user_id::text || ':%')
    );
  GET DIAGNOSTICS v_withdrawn = ROW_COUNT;
  RETURN v_withdrawn;
END;
$$;

REVOKE ALL ON FUNCTION public.create_post_save_alert(uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_post_save_alert(uuid, uuid, uuid, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION public.withdraw_post_save_alert(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_post_save_alert(uuid, uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.withdraw_post_save_alerts_between(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_post_save_alerts_between(uuid, uuid)
  TO service_role;

-- Withdrawn alerts go once their deliveries have: their receipts are read
-- from those rows until then.
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
  v_withdrawn integer;
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

  WITH victims AS (
    SELECT id FROM public.mobile_notifications
    WHERE withdrawn_at IS NOT NULL AND withdrawn_at < p_delivery_cutoff
    ORDER BY withdrawn_at, id LIMIT v_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.mobile_notifications AS notifications
  USING victims WHERE notifications.id = victims.id;
  GET DIAGNOSTICS v_withdrawn = ROW_COUNT;

  RETURN jsonb_build_object(
    'deliveriesDeleted', v_deliveries,
    'notificationsDeleted', v_notifications + v_withdrawn,
    'batchLimitReached', v_deliveries = v_limit OR v_notifications = v_limit OR v_withdrawn = v_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_mobile_notification_retention(timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_mobile_notification_retention(timestamptz, timestamptz, integer)
  TO service_role;

-- Clear the actor from anonymous save and share alerts. The trigger is set
-- aside so the repair does not stamp updated_at (which read-alert retention
-- counts from); one statement, so a failed repair cannot leave it off.
DO $$
BEGIN
  ALTER TABLE public.mobile_notifications DISABLE TRIGGER mobile_notifications_set_updated_at;

  UPDATE public.mobile_notifications
  SET actor_user_id = NULL
  WHERE type IN ('post_saved', 'post_shared')
    AND aggregation_key IS NOT NULL
    AND actor_user_id IS NOT NULL;

  ALTER TABLE public.mobile_notifications ENABLE TRIGGER mobile_notifications_set_updated_at;
END;
$$;

-- Save alerts that name whoever saved ("@maya saved your post").
--
-- 1. A named save alert belongs to its save. save_user_id and save_post_id
--    point at the post_saves row the alert announces, ON DELETE CASCADE: an
--    unsave, the saver's account being deleted and the post being deleted
--    each remove the alert in their own transaction, and an alert written
--    after its save is gone fails the foreign key, which
--    create_post_save_alert answers wasCreated false. Nothing else keeps the
--    two in step, so no path that removes a save can leave its alert behind.
-- 2. A push delivery outlives its alert. notification_id is set to NULL when
--    the alert goes, so the delivery's receipt still retires a dead token,
--    and the retry job closes a delivery whose alert is gone instead of
--    sending it.
-- 3. A block between two accounts removes every save alert naming either of
--    them to the other, and create_post_save_alert writes none across a
--    block. Both take one lock per pair of accounts, so a block and an alert
--    written at the same moment cannot miss each other.
-- 4. Anonymous alerts keep no one. upsert_mobile_notification stores no actor
--    on grouped "Someone saved your post" and "Someone shared your post" rows
--    whatever its caller passes (a deployment still running the old code
--    while this applies included), and the actor is cleared from the rows
--    already written.
--
-- profiles.saver_notice_seen_at, the told record naming waits for, comes in
-- the next migration on its own: altering profiles takes a lock that every
-- admitted API call queues behind.

SET LOCAL lock_timeout = '5s';

-- 1. A named save alert belongs to its save.

ALTER TABLE public.mobile_notifications
  ADD COLUMN IF NOT EXISTS save_user_id uuid,
  ADD COLUMN IF NOT EXISTS save_post_id uuid;

ALTER TABLE public.mobile_notifications
  DROP CONSTRAINT IF EXISTS mobile_notifications_save_pair_check,
  ADD CONSTRAINT mobile_notifications_save_pair_check
    CHECK ((save_user_id IS NULL) = (save_post_id IS NULL));

-- MATCH SIMPLE: a row with no save (every alert but a named save's) is not
-- checked.
ALTER TABLE public.mobile_notifications
  DROP CONSTRAINT IF EXISTS mobile_notifications_save_fkey,
  ADD CONSTRAINT mobile_notifications_save_fkey
    FOREIGN KEY (save_user_id, save_post_id)
    REFERENCES public.post_saves (user_id, post_id)
    ON DELETE CASCADE;

-- The cascade and the block below find a save's alerts through it.
CREATE INDEX IF NOT EXISTS mobile_notifications_save_idx
  ON public.mobile_notifications (save_user_id, save_post_id)
  WHERE save_user_id IS NOT NULL;

COMMENT ON COLUMN public.mobile_notifications.save_user_id IS
  'With save_post_id, the post_saves row a named save alert announces; the alert goes with the save (ON DELETE CASCADE). Not granted to the alert''s owner.';
COMMENT ON COLUMN public.mobile_notifications.save_post_id IS
  'With save_user_id, the post_saves row a named save alert announces; the alert goes with the save (ON DELETE CASCADE). Not granted to the alert''s owner.';

-- 2. A push delivery outlives its alert.

ALTER TABLE public.mobile_push_deliveries
  ALTER COLUMN notification_id DROP NOT NULL;

ALTER TABLE public.mobile_push_deliveries
  DROP CONSTRAINT IF EXISTS mobile_push_deliveries_notification_id_fkey,
  ADD CONSTRAINT mobile_push_deliveries_notification_id_fkey
    FOREIGN KEY (notification_id) REFERENCES public.mobile_notifications (id)
    ON DELETE SET NULL;

COMMENT ON COLUMN public.mobile_push_deliveries.notification_id IS
  'The alert this delivery pushed. NULL once the alert is gone: the delivery stays for its receipt, and a retry of it is closed unsent.';

-- 3. Writing a named save alert, and a block between two accounts.

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
  v_row public.mobile_notifications%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF p_recipient_user_id IS NULL OR p_actor_user_id IS NULL OR p_post_id IS NULL
    OR p_recipient_user_id = p_actor_user_id THEN
    RETURN jsonb_build_object('wasCreated', false, 'notification', NULL);
  END IF;

  -- The lock remove_post_save_alerts_for_user_block takes for this pair of
  -- accounts: a block made while this runs is either seen below or removes
  -- what this writes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'user-pair:' || least(p_recipient_user_id, p_actor_user_id)::text
      || ':' || greatest(p_recipient_user_id, p_actor_user_id)::text,
    0
  ));

  IF EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE (blocker_user_id = p_recipient_user_id AND blocked_user_id = p_actor_user_id)
       OR (blocker_user_id = p_actor_user_id AND blocked_user_id = p_recipient_user_id)
  ) THEN
    RETURN jsonb_build_object('wasCreated', false, 'notification', NULL);
  END IF;

  BEGIN
    INSERT INTO public.mobile_notifications (
      user_id, actor_user_id, type, category, title, body, deep_link,
      object_type, object_id, dedupe_key, save_user_id, save_post_id
    )
    VALUES (
      p_recipient_user_id, p_actor_user_id, 'post_saved', 'social', p_title, p_body, p_deep_link,
      'post', p_post_id::text, 'post-save:' || p_actor_user_id::text || ':' || p_post_id::text,
      p_actor_user_id, p_post_id
    )
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;
    v_created := FOUND;
  EXCEPTION WHEN foreign_key_violation THEN
    -- The save is already gone: an alert announcing it would stand for nothing.
    RETURN jsonb_build_object('wasCreated', false, 'notification', NULL);
  END;

  -- Not created: this save's alert stands already.
  RETURN jsonb_build_object(
    'wasCreated', v_created,
    'notification', CASE WHEN v_created THEN to_jsonb(v_row) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_post_save_alert(uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_post_save_alert(uuid, uuid, uuid, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.remove_post_save_alerts_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The lock create_post_save_alert takes for this pair of accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'user-pair:' || least(NEW.blocker_user_id, NEW.blocked_user_id)::text
      || ':' || greatest(NEW.blocker_user_id, NEW.blocked_user_id)::text,
    0
  ));

  DELETE FROM public.mobile_notifications
  WHERE save_user_id IS NOT NULL
    AND (
      (user_id = NEW.blocker_user_id AND save_user_id = NEW.blocked_user_id)
      OR (user_id = NEW.blocked_user_id AND save_user_id = NEW.blocker_user_id)
    );

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_post_save_alerts_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_post_save_alerts_for_user_block() TO service_role;

DROP TRIGGER IF EXISTS user_blocks_remove_post_save_alerts ON public.user_blocks;
CREATE TRIGGER user_blocks_remove_post_save_alerts
AFTER INSERT OR UPDATE ON public.user_blocks
FOR EACH ROW
EXECUTE FUNCTION public.remove_post_save_alerts_for_user_block();

COMMENT ON FUNCTION public.remove_post_save_alerts_for_user_block() IS
  'Removes every save alert that names either blocked account to the other.';

-- 4. Anonymous alerts keep no one. As 20261003010001 defined it, except that
-- a grouped save or share row never stores an actor.

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
  v_actor_user_id uuid := CASE
    WHEN p_type IN ('post_saved', 'post_shared') THEN NULL
    ELSE p_actor_user_id
  END;
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
    v_actor_user_id,
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
  uuid, uuid, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_mobile_notification(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) TO service_role;

-- Clear the actor from the anonymous save and share alerts already written.
-- The trigger is set aside so the repair does not stamp updated_at (which
-- read-alert retention counts from); one statement, so a failed repair cannot
-- leave it off.
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

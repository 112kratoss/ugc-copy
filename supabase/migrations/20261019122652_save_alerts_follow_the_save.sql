-- Save alerts that name whoever saved ("@maya saved your post").
--
-- 1. A named save alert belongs to its save. save_user_id and save_post_id
--    point at the post_saves row the alert announces, ON DELETE CASCADE: an
--    unsave, the saver's account being deleted and the post being deleted or
--    tombstoned (20261019211234) each remove the alert in their own
--    transaction, and an alert written after its save is gone fails the
--    foreign key, which create_post_save_alert answers wasCreated false.
--    Nothing else keeps the two in step, so no path that removes a save can
--    leave its alert behind.
-- 2. A push delivery outlives its alert. notification_id is set to NULL when
--    the alert goes, so the delivery's receipt still retires a dead token,
--    and a retry can no longer claim a delivery whose alert is gone.
-- 3. create_post_save_alert decides on its own whether a save may name its
--    saver: the alert goes to the post's owner, only for a saver told on
--    record (profiles.saver_notice_seen_at) with a handle they chose, and
--    never across a block. The title is built here from that handle.
-- 4. A block between two accounts removes every save alert naming either of
--    them to the other, in the trigger that already removes their follows,
--    under the same per-pair lock create_post_save_alert takes: a block and
--    an alert written at the same moment cannot miss each other.
-- 5. Anonymous alerts keep no one. upsert_mobile_notification stores no actor
--    on grouped "Someone saved your post" and "Someone shared your post" rows
--    whatever its caller passes; the rows already written are cleared in
--    20261019211233.
--
-- profiles.saver_notice_seen_at, the told record naming waits for, comes in
-- its own migration (20261019182554): altering profiles takes a lock that
-- every admitted API call queues behind.

SET LOCAL lock_timeout = '5s';

-- Every table lock this file needs, taken before it changes anything and in
-- the order live writers take them. A save or an unsave holds post_saves
-- before alerts (its cascade comes later in the same statement); a push
-- reservation and the retention prune hold deliveries before alerts (the key
-- check, then the second delete). Taken the other way round, this file could
-- hold one table while such a writer held the other and waited for it. In a
-- block, as 20260714111000 takes its lock: the CLI applies a file's
-- statements outside a transaction block, where LOCK TABLE is refused and
-- SET LOCAL does nothing; the locks are held to the end of the file's
-- transaction all the same, and the timeout is set again for their waits.
DO $locks$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.post_saves IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.mobile_push_deliveries IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.mobile_notifications IN ACCESS EXCLUSIVE MODE;
END;
$locks$;

-- 1. A named save alert belongs to its save.

ALTER TABLE public.mobile_notifications
  ADD COLUMN IF NOT EXISTS save_user_id uuid,
  ADD COLUMN IF NOT EXISTS save_post_id uuid;

ALTER TABLE public.mobile_notifications
  DROP CONSTRAINT IF EXISTS mobile_notifications_save_pair_check,
  ADD CONSTRAINT mobile_notifications_save_pair_check
    CHECK ((save_user_id IS NULL) = (save_post_id IS NULL));

-- The cascade and the block below find a save's alerts through it. Built
-- before the key, whose check then reads this empty index instead of every
-- alert.
CREATE INDEX IF NOT EXISTS mobile_notifications_save_idx
  ON public.mobile_notifications (save_user_id, save_post_id)
  WHERE save_user_id IS NOT NULL;

-- MATCH SIMPLE: a row with no save (every alert but a named save's) is not
-- checked.
ALTER TABLE public.mobile_notifications
  DROP CONSTRAINT IF EXISTS mobile_notifications_save_fkey,
  ADD CONSTRAINT mobile_notifications_save_fkey
    FOREIGN KEY (save_user_id, save_post_id)
    REFERENCES public.post_saves (user_id, post_id)
    ON DELETE CASCADE;

COMMENT ON COLUMN public.mobile_notifications.save_user_id IS
  'With save_post_id, the post_saves row a named save alert announces; the alert goes with the save (ON DELETE CASCADE). Not granted to the alert''s owner.';
COMMENT ON COLUMN public.mobile_notifications.save_post_id IS
  'With save_user_id, the post_saves row a named save alert announces; the alert goes with the save (ON DELETE CASCADE). Not granted to the alert''s owner.';

-- 2. A push delivery outlives its alert.

ALTER TABLE public.mobile_push_deliveries
  ALTER COLUMN notification_id DROP NOT NULL;

-- NOT VALID: the key it replaces already held every row to an alert, so it is
-- checked in 20261019211235, outside these locks, instead of here.
ALTER TABLE public.mobile_push_deliveries
  DROP CONSTRAINT IF EXISTS mobile_push_deliveries_notification_id_fkey,
  ADD CONSTRAINT mobile_push_deliveries_notification_id_fkey
    FOREIGN KEY (notification_id) REFERENCES public.mobile_notifications (id)
    ON DELETE SET NULL NOT VALID;

COMMENT ON COLUMN public.mobile_push_deliveries.notification_id IS
  'The alert this delivery pushed. NULL once the alert is gone: the delivery stays for its receipt, and a retry of it is closed unsent.';

-- As 20261005031821 defined it, except that a delivery whose alert is gone
-- cannot be claimed. The claim updates the row the alert's removal sets to
-- NULL, so the two are taken one after the other: a retry claimed is one
-- whose alert stood when it was claimed.
CREATE OR REPLACE FUNCTION public.claim_mobile_push_retry(p_delivery_id uuid, p_expected_attempt_count integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_claim uuid := gen_random_uuid();
BEGIN
  IF p_expected_attempt_count IS NULL OR p_expected_attempt_count < 0 OR p_expected_attempt_count >= 3 THEN
    RAISE EXCEPTION 'Invalid push retry attempt count' USING ERRCODE = '22023';
  END IF;
  UPDATE public.mobile_push_deliveries AS delivery
  SET token_id = (SELECT token.id FROM public.mobile_push_tokens AS token
        WHERE token.user_id = delivery.user_id AND token.expo_push_token = delivery.expo_push_token
          AND token.is_active = true LIMIT 1),
      retry_claim_id = v_claim, retry_claim_until = clock_timestamp() + interval '60 seconds',
      attempt_count = attempt_count + 1, last_attempt_at = clock_timestamp(),
      receipt_error_code = 'PushRetryOutcomeUnknown',
      receipt_message = 'Retry attempt reserved; provider outcome has not been recorded.'
  WHERE id = p_delivery_id AND notification_id IS NOT NULL
    AND send_status = 'error' AND receipt_status = 'error'
    AND push_ticket_id IS NULL AND retry_outcome IS NULL AND attempt_count = p_expected_attempt_count
    AND (retry_claim_until IS NULL OR retry_claim_until <= clock_timestamp());
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_claim;
END;
$$;

-- 3. Writing a named save alert.

-- What it answers:
-- - nameable false: the saver may not be named (not told on record, or no
--   handle they chose). Nothing is written; the caller writes the grouped
--   "Someone saved your post" alert instead.
-- - nameable true, wasCreated true: the alert, under notification.
-- - nameable true, wasCreated false: nothing is to be written. This save's
--   alert stands already, the save or the post is gone, or the two accounts
--   are blocked.
CREATE OR REPLACE FUNCTION public.create_post_save_alert(
  p_post_id uuid,
  p_saver_user_id uuid,
  p_body text,
  p_deep_link text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recipient_user_id uuid;
  v_username text;
  v_seen_at timestamptz;
  v_handle text;
  v_row public.mobile_notifications%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF p_post_id IS NULL OR p_saver_user_id IS NULL THEN
    RAISE EXCEPTION 'A post and a saver are required' USING ERRCODE = '22023';
  END IF;

  -- The alert goes to whoever owns the post, never to an account the caller
  -- names. A post already gone took its saves with it.
  SELECT post.user_id INTO v_recipient_user_id
  FROM public.posts AS post
  WHERE post.id = p_post_id;
  IF v_recipient_user_id IS NULL OR v_recipient_user_id = p_saver_user_id THEN
    RETURN jsonb_build_object('nameable', true, 'wasCreated', false, 'notification', NULL);
  END IF;

  -- Saves were private: only a saver told on record that creators can see
  -- who saved, by a handle they chose (isClaimedProfileUsername in
  -- src/lib/profile.ts; the creator-xxxxxxxx placeholder is not one).
  SELECT profile.username, profile.saver_notice_seen_at
  INTO v_username, v_seen_at
  FROM public.profiles AS profile
  WHERE profile.id = p_saver_user_id;
  v_handle := lower(regexp_replace(btrim(coalesce(v_username, '')), '^@+', ''));
  IF v_seen_at IS NULL
    OR v_handle !~ '^[a-z0-9-]{3,24}$'
    OR v_handle ~ '^creator-[a-f0-9]{8}$' THEN
    RETURN jsonb_build_object('nameable', false, 'wasCreated', false, 'notification', NULL);
  END IF;

  -- The lock a block between the two takes (remove_follows_for_user_block):
  -- a block made while this runs is either seen below or removes what this
  -- writes.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'follow-block:' || least(v_recipient_user_id, p_saver_user_id)::text
      || ':' || greatest(v_recipient_user_id, p_saver_user_id)::text,
    0
  ));

  IF EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE (blocker_user_id = v_recipient_user_id AND blocked_user_id = p_saver_user_id)
       OR (blocker_user_id = p_saver_user_id AND blocked_user_id = v_recipient_user_id)
  ) THEN
    RETURN jsonb_build_object('nameable', true, 'wasCreated', false, 'notification', NULL);
  END IF;

  BEGIN
    INSERT INTO public.mobile_notifications (
      user_id, actor_user_id, type, category, title, body, deep_link,
      object_type, object_id, dedupe_key, save_user_id, save_post_id
    )
    VALUES (
      v_recipient_user_id, p_saver_user_id, 'post_saved', 'social',
      '@' || v_handle || ' saved your post', p_body, p_deep_link,
      'post', p_post_id::text, 'post-save:' || p_saver_user_id::text || ':' || p_post_id::text,
      p_saver_user_id, p_post_id
    )
    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;
    v_created := FOUND;
  EXCEPTION WHEN foreign_key_violation THEN
    -- The save is already gone: an alert announcing it would stand for nothing.
    RETURN jsonb_build_object('nameable', true, 'wasCreated', false, 'notification', NULL);
  END;

  -- Not created: this save's alert stands already.
  RETURN jsonb_build_object(
    'nameable', true,
    'wasCreated', v_created,
    'notification', CASE WHEN v_created THEN to_jsonb(v_row) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_post_save_alert(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_post_save_alert(uuid, uuid, text, text)
  TO service_role;

-- 4. A block between two accounts. As 20261004121413 defined it, and the
-- save alerts naming either to the other go too, under the same lock.

CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Wait for any admitted follow, or named save alert, to commit before
  -- removing it. The opposite ordering makes the follow trigger and
  -- create_post_save_alert observe this block after their lock wait.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'follow-block:' || least(NEW.blocker_user_id, NEW.blocked_user_id)::text || ':' ||
    greatest(NEW.blocker_user_id, NEW.blocked_user_id)::text, 0
  ));

  DELETE FROM public.follows
  WHERE (
    follower_id = NEW.blocker_user_id
    AND following_id = NEW.blocked_user_id
  ) OR (
    follower_id = NEW.blocked_user_id
    AND following_id = NEW.blocker_user_id
  );

  DELETE FROM public.mobile_notifications
  WHERE save_user_id IS NOT NULL
    AND (
      (user_id = NEW.blocker_user_id AND save_user_id = NEW.blocked_user_id)
      OR (user_id = NEW.blocked_user_id AND save_user_id = NEW.blocker_user_id)
    );

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_follows_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follows_for_user_block() TO service_role;

COMMENT ON FUNCTION public.remove_follows_for_user_block() IS
  'When one account blocks another: removes the follows between them, either way, and every save alert naming either to the other.';

-- 5. Anonymous alerts keep no one. As 20261003010001 defined it, except that
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

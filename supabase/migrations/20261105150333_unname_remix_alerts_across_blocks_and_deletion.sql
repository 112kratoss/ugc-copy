-- A remix's alerts name the remixer in their stored words (owner, 2026-11-05;
-- src/lib/completed-remix-notification.ts, remixAlertWords):
--   finished  "@maya remixed your post"           opening /creators/maya
--   posted    "@maya posted a remix of your post" opening maya's post
-- and with no one to name, the words they had before:
--   "Someone remixed your post" / "Someone posted a remix of your post",
--   opening the post that was remixed (the alert's object).
-- The words do not follow the people in them, so the database takes the name and
-- the link back out wherever they no longer belong, as it does a follow's
-- (20261020072851) and a sale's (20261020053858):
--   1. the remixer's account deleted: the foreign key clears actor_user_id, and
--      the handle is free for anyone to claim;
--   2. a block made after the alert, either way round, in the one trigger on
--      blocks (remove_follows_for_user_block, as 20261020072851 defined it);
--   3. an alert written across a block, either way round. A remix is refused
--      across a block when it starts, but its run finishes, and its post goes
--      out, later.
-- A block unnames the alert rather than removing it: the row is the alert's
-- dedupe record (createMobileNotification looks for user_id and dedupe_key
-- before it writes). 2 and 3 take the lock the follow and sale alerts take for
-- the pair, so a block and an alert written at the same moment are seen one
-- after the other. Every remix alert stored before this names no one, so none
-- needs repair.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The table the triggers go on, locked before anything changes. SHARE ROW
-- EXCLUSIVE is what CREATE TRIGGER takes, and reads go on beside it; the
-- triggers are made with CREATE OR REPLACE, never DROP TRIGGER, which would lock
-- the inbox's reads out.
LOCK TABLE public.mobile_notifications IN SHARE ROW EXCLUSIVE MODE;

-- The title and link a remix alert has with no remixer to name. An alert that
-- names no one comes back as it is.
CREATE OR REPLACE FUNCTION public.unnamed_remix_alert_words(
  p_title text,
  p_deep_link text,
  p_object_id text,
  OUT title text,
  OUT deep_link text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  title := p_title;
  deep_link := p_deep_link;
  IF p_title ~ '^@\S+ remixed your post$' THEN
    title := 'Someone remixed your post';
  ELSIF p_title ~ '^@\S+ posted a remix of your post$' THEN
    title := 'Someone posted a remix of your post';
  ELSE
    RETURN;
  END IF;
  -- The remixer's page or post goes with the name: the alert opens the post
  -- that was remixed, as before the alerts named anyone.
  deep_link := CASE
    WHEN nullif(p_object_id, '') IS NULL THEN '/studio'
    ELSE '/showcase/' || p_object_id
  END;
END
$$;

REVOKE ALL ON FUNCTION public.unnamed_remix_alert_words(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unnamed_remix_alert_words(text, text, text) TO service_role;

COMMENT ON FUNCTION public.unnamed_remix_alert_words(text, text, text) IS
  'The title and link a remix alert has with no remixer to name; an alert that names no one comes back unchanged.';

-- 1 and 3. A remix alert whose remixer's account was deleted, or written across a
-- block, is stored without the name.
CREATE OR REPLACE FUNCTION public.unname_remix_alert_that_cannot_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_words record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A block for the pair being made now commits first and is seen below; one
    -- made after this waits, then finds this alert to unname.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'follow-block:' || least(NEW.user_id, NEW.actor_user_id)::text || ':' ||
      greatest(NEW.user_id, NEW.actor_user_id)::text, 0
    ));

    IF NOT EXISTS (
      SELECT 1 FROM public.user_blocks
      WHERE (blocker_user_id = NEW.user_id AND blocked_user_id = NEW.actor_user_id)
         OR (blocker_user_id = NEW.actor_user_id AND blocked_user_id = NEW.user_id)
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Written across a block, or the remixer's account is gone.
  SELECT words.title, words.deep_link INTO v_words
  FROM public.unnamed_remix_alert_words(NEW.title, NEW.deep_link, NEW.object_id) AS words;
  NEW.title := v_words.title;
  NEW.deep_link := v_words.deep_link;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.unname_remix_alert_that_cannot_name() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unname_remix_alert_that_cannot_name() TO service_role;

COMMENT ON FUNCTION public.unname_remix_alert_that_cannot_name() IS
  'Stores a remix alert without its remixer''s name or page when it is written across a block, or once the remixer''s account is deleted.';

CREATE OR REPLACE TRIGGER mobile_notifications_unname_remix_alert_across_block
BEFORE INSERT ON public.mobile_notifications
FOR EACH ROW
WHEN (NEW.type = 'post_remixed' AND NEW.actor_user_id IS NOT NULL)
EXECUTE FUNCTION public.unname_remix_alert_that_cannot_name();

-- The foreign key's ON DELETE SET NULL is an update of actor_user_id.
CREATE OR REPLACE TRIGGER mobile_notifications_unname_remix_alert_of_deleted_remixer
BEFORE UPDATE OF actor_user_id ON public.mobile_notifications
FOR EACH ROW
WHEN (
  NEW.type = 'post_remixed'
  AND OLD.actor_user_id IS NOT NULL
  AND NEW.actor_user_id IS NULL
)
EXECUTE FUNCTION public.unname_remix_alert_that_cannot_name();

-- 2. A block between two accounts. As 20261020072851 defined it, and the remix
-- alerts naming either to the other keep the remix without the name, under the
-- same lock.
CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Wait for any admitted follow, named save alert, sale alert, follow alert or
  -- remix alert to commit before removing or unnaming it. The opposite ordering
  -- makes the follow trigger, create_post_save_alert and an alert's insert
  -- observe this block after their lock wait.
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

  -- A sale stays a sale: its alert keeps the words a buyer with no handle gets.
  UPDATE public.mobile_notifications AS alert
  SET title = words.title,
      body = words.body
  FROM public.mobile_notifications AS named
  CROSS JOIN LATERAL public.unnamed_sale_alert_words(named.title, named.body) AS words
  WHERE alert.id = named.id
    AND named.type = 'post_resource_unlocked'
    AND (
      (named.user_id = NEW.blocker_user_id AND named.actor_user_id = NEW.blocked_user_id)
      OR (named.user_id = NEW.blocked_user_id AND named.actor_user_id = NEW.blocker_user_id)
    )
    AND (words.title, words.body) IS DISTINCT FROM (named.title, named.body);

  -- A follow alert keeps the words and link a follower with no handle gets:
  -- its row is what stops the same follow being announced again.
  UPDATE public.mobile_notifications AS alert
  SET body = words.body,
      deep_link = words.deep_link
  FROM public.mobile_notifications AS named
  CROSS JOIN LATERAL public.unnamed_follow_alert_words(named.body, named.deep_link) AS words
  WHERE alert.id = named.id
    AND named.type = 'creator_followed'
    AND (
      (named.user_id = NEW.blocker_user_id AND named.actor_user_id = NEW.blocked_user_id)
      OR (named.user_id = NEW.blocked_user_id AND named.actor_user_id = NEW.blocker_user_id)
    )
    AND (words.body, words.deep_link) IS DISTINCT FROM (named.body, named.deep_link);

  -- A remix stays a remix: its alerts keep the words that name no one and open
  -- the post that was remixed.
  UPDATE public.mobile_notifications AS alert
  SET title = words.title,
      deep_link = words.deep_link
  FROM public.mobile_notifications AS named
  CROSS JOIN LATERAL public.unnamed_remix_alert_words(named.title, named.deep_link, named.object_id) AS words
  WHERE alert.id = named.id
    AND named.type = 'post_remixed'
    AND (
      (named.user_id = NEW.blocker_user_id AND named.actor_user_id = NEW.blocked_user_id)
      OR (named.user_id = NEW.blocked_user_id AND named.actor_user_id = NEW.blocker_user_id)
    )
    AND (words.title, words.deep_link) IS DISTINCT FROM (named.title, named.deep_link);

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_follows_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follows_for_user_block() TO service_role;

COMMENT ON FUNCTION public.remove_follows_for_user_block() IS
  'When one account blocks another: removes the follows between them, either way, and every save alert naming either to the other; sale, follow and remix alerts between them keep the sale, the follow or the remix without the name.';

COMMIT;

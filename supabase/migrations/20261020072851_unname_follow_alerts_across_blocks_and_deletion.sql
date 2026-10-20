-- A follow's alert names its follower in its stored words, and opens their
-- page (src/lib/mobile-notifications.ts, notifyCreatorFollowed):
--   named      "New follower" · "@maya followed you."  opening /creators/maya
--   no handle  "New follower" · "Someone followed your creator profile."
--              opening Alerts (/studio)
-- The words do not follow the people in them, so the database takes the name
-- and the link back out wherever they no longer belong, leaving the words and
-- the link the alert has for a follower with no handle:
--   1. the follower's account deleted: the foreign key clears actor_user_id,
--      and the handle is free for anyone to claim, so the alert would name,
--      and open the page of, whoever claims it next;
--   2. a block made after the alert, either way round, in the one trigger on
--      blocks (remove_follows_for_user_block, as 20261020053858 defined it),
--      which already removes the follow itself;
--   3. an alert written across a block, either way round. A follow is refused
--      across a block, but its alert is written after the follow commits and
--      the answer has gone, and a block can land in between.
-- A block unnames the alert rather than removing it, as it does a sale's: the
-- row is the follow's dedupe record (createMobileNotification looks for
-- user_id and dedupe_key before it writes), and without it a block, an
-- unblock and a follow again would push the same account another alert.
-- 2 and 3 take the lock remove_follows_for_user_block and
-- reject_blocked_user_follow take for the pair, so a block and an alert
-- written at the same moment are seen one after the other.
-- 4. The alerts already stored that 1 or 2 would have unnamed.

SET LOCAL lock_timeout = '5s';

-- The table the triggers go on, locked before anything changes. In a block, as
-- 20261020053858 takes its lock: the CLI applies a file's statements outside
-- a transaction block, where LOCK TABLE is refused and SET LOCAL does nothing.
-- SHARE ROW EXCLUSIVE is what CREATE TRIGGER takes, and reads go on beside it;
-- the triggers are made with CREATE OR REPLACE, never DROP TRIGGER, which
-- would lock the inbox's reads out.
DO $locks$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.mobile_notifications IN SHARE ROW EXCLUSIVE MODE;
END;
$locks$;

-- The words and link a follow alert has with no one to name. An alert that
-- names no one comes back as it is.

CREATE OR REPLACE FUNCTION public.unnamed_follow_alert_words(
  p_body text,
  p_deep_link text,
  OUT body text,
  OUT deep_link text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  body := p_body;
  deep_link := p_deep_link;
  IF p_body ~ '^@\S+ followed you\.$' OR p_deep_link ~ '^/creators/' THEN
    body := 'Someone followed your creator profile.';
    deep_link := '/studio';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.unnamed_follow_alert_words(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unnamed_follow_alert_words(text, text) TO service_role;

COMMENT ON FUNCTION public.unnamed_follow_alert_words(text, text) IS
  'The words and link a New follower alert has with no follower to name; an alert that names no one comes back unchanged.';

-- 1 and 3. A follow alert whose follower's account was deleted, or written
-- across a block, is stored without the name.

CREATE OR REPLACE FUNCTION public.unname_follow_alert_that_cannot_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_words record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A block for the pair being made now commits first and is seen below;
    -- one made after this waits, then finds this alert to unname.
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

  -- Written across a block, or the follower's account is gone.
  SELECT words.body, words.deep_link INTO v_words
  FROM public.unnamed_follow_alert_words(NEW.body, NEW.deep_link) AS words;
  NEW.body := v_words.body;
  NEW.deep_link := v_words.deep_link;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.unname_follow_alert_that_cannot_name() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unname_follow_alert_that_cannot_name() TO service_role;

COMMENT ON FUNCTION public.unname_follow_alert_that_cannot_name() IS
  'Stores a New follower alert without its follower''s name or page when it is written across a block, or once the follower''s account is deleted.';

CREATE OR REPLACE TRIGGER mobile_notifications_unname_follow_alert_across_block
BEFORE INSERT ON public.mobile_notifications
FOR EACH ROW
WHEN (NEW.type = 'creator_followed' AND NEW.actor_user_id IS NOT NULL)
EXECUTE FUNCTION public.unname_follow_alert_that_cannot_name();

-- The foreign key's ON DELETE SET NULL is an update of actor_user_id.
CREATE OR REPLACE TRIGGER mobile_notifications_unname_follow_alert_of_deleted_follower
BEFORE UPDATE OF actor_user_id ON public.mobile_notifications
FOR EACH ROW
WHEN (
  NEW.type = 'creator_followed'
  AND OLD.actor_user_id IS NOT NULL
  AND NEW.actor_user_id IS NULL
)
EXECUTE FUNCTION public.unname_follow_alert_that_cannot_name();

-- 2. A block between two accounts. As 20261020053858 defined it, and the
-- follow alerts naming either to the other keep the follow without the name,
-- under the same lock.

CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Wait for any admitted follow, named save alert, sale alert or follow
  -- alert to commit before removing or unnaming it. The opposite ordering
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

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_follows_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follows_for_user_block() TO service_role;

COMMENT ON FUNCTION public.remove_follows_for_user_block() IS
  'When one account blocks another: removes the follows between them, either way, and every save alert naming either to the other; sale and follow alerts between them keep the sale or the follow without the name.';

-- 4. The alerts stored before this: those whose follower's account is gone,
-- and those across a block made before it. The trigger that stamps
-- updated_at is set aside, as 20261019211233 set it aside, so the repair does
-- not restart read-alert retention; one statement, so a failed repair cannot
-- leave it off.
DO $repair$
BEGIN
  ALTER TABLE public.mobile_notifications DISABLE TRIGGER mobile_notifications_set_updated_at;

  UPDATE public.mobile_notifications AS alert
  SET body = words.body,
      deep_link = words.deep_link
  FROM public.mobile_notifications AS named
  CROSS JOIN LATERAL public.unnamed_follow_alert_words(named.body, named.deep_link) AS words
  WHERE alert.id = named.id
    AND named.type = 'creator_followed'
    AND (
      named.actor_user_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.user_blocks AS block
        WHERE (block.blocker_user_id = named.user_id AND block.blocked_user_id = named.actor_user_id)
           OR (block.blocker_user_id = named.actor_user_id AND block.blocked_user_id = named.user_id)
      )
    )
    AND (words.body, words.deep_link) IS DISTINCT FROM (named.body, named.deep_link);

  ALTER TABLE public.mobile_notifications ENABLE TRIGGER mobile_notifications_set_updated_at;
END;
$repair$;

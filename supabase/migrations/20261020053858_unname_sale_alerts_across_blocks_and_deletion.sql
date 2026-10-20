-- A sale's alert names its buyer in its stored words
-- (src/lib/mobile-notifications.ts, sellerUnlockWords):
--   a sale       "You made a sale" · "@maya bought the resources attached to your post."
--   a free open  "@maya opened your free resources" · "They can view the prompt, files, or workflow now."
-- The words do not follow the people in them, so the database takes the name
-- back out wherever it no longer belongs, leaving the words such an alert has
-- for a buyer with no handle:
--   1. an alert written across a block, either way round. A buy is refused
--      across a block, but a Razorpay checkout settles after its order was
--      made, and a block can land in between (a UPI payment still pending);
--   2. a block made after the alert, either way round, in the one trigger on
--      blocks (remove_follows_for_user_block, as 20261019122652 defined it);
--   3. the buyer's account deleted: the foreign key clears actor_user_id, and
--      the handle is free for anyone to claim.
-- 1 and 2 take the lock remove_follows_for_user_block and
-- create_post_save_alert take for the pair, so a block and an alert written at
-- the same moment are seen one after the other. Recent sales still lists a
-- paid buyer by their live handle.

SET LOCAL lock_timeout = '5s';

-- The table the triggers go on, locked before anything changes. In a block, as
-- 20261019122652 takes its locks: the CLI applies a file's statements outside
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

-- The words a sale alert has with no one to name. Words that name no one come
-- back as they are.

CREATE OR REPLACE FUNCTION public.unnamed_sale_alert_words(
  p_title text,
  p_body text,
  OUT title text,
  OUT body text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  title := p_title;
  body := p_body;
  IF p_title ~ '^@\S+ opened your free resources$' THEN
    title := 'Someone opened your free resources';
    body := 'A creator opened the resources attached to your post.';
  ELSIF p_body ~ '^@\S+ bought the resources attached to your post\.$' THEN
    body := 'A creator bought the resources attached to your post.';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.unnamed_sale_alert_words(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unnamed_sale_alert_words(text, text) TO service_role;

COMMENT ON FUNCTION public.unnamed_sale_alert_words(text, text) IS
  'The words a recipe sale or free-open alert has with no buyer to name; words that name no one come back unchanged.';

-- 1 and 3. A sale alert written across a block, or whose buyer's account was
-- deleted, is stored without the name.

CREATE OR REPLACE FUNCTION public.unname_sale_alert_that_cannot_name()
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

  -- Written across a block, or the buyer's account is gone.
  SELECT words.title, words.body INTO v_words
  FROM public.unnamed_sale_alert_words(NEW.title, NEW.body) AS words;
  NEW.title := v_words.title;
  NEW.body := v_words.body;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.unname_sale_alert_that_cannot_name() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unname_sale_alert_that_cannot_name() TO service_role;

COMMENT ON FUNCTION public.unname_sale_alert_that_cannot_name() IS
  'Stores a recipe sale or free-open alert without its buyer''s name when it is written across a block, or once the buyer''s account is deleted.';

CREATE OR REPLACE TRIGGER mobile_notifications_unname_sale_alert_across_block
BEFORE INSERT ON public.mobile_notifications
FOR EACH ROW
WHEN (NEW.type = 'post_resource_unlocked' AND NEW.actor_user_id IS NOT NULL)
EXECUTE FUNCTION public.unname_sale_alert_that_cannot_name();

-- The foreign key's ON DELETE SET NULL is an update of actor_user_id.
CREATE OR REPLACE TRIGGER mobile_notifications_unname_sale_alert_of_deleted_buyer
BEFORE UPDATE OF actor_user_id ON public.mobile_notifications
FOR EACH ROW
WHEN (
  NEW.type = 'post_resource_unlocked'
  AND OLD.actor_user_id IS NOT NULL
  AND NEW.actor_user_id IS NULL
)
EXECUTE FUNCTION public.unname_sale_alert_that_cannot_name();

-- 2. A block between two accounts. As 20261019122652 defined it, and the sale
-- alerts naming either to the other keep the sale without the name, under the
-- same lock.

CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Wait for any admitted follow, named save alert or sale alert to commit
  -- before removing or unnaming it. The opposite ordering makes the follow
  -- trigger, create_post_save_alert and a sale alert's insert observe this
  -- block after their lock wait.
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

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_follows_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follows_for_user_block() TO service_role;

COMMENT ON FUNCTION public.remove_follows_for_user_block() IS
  'When one account blocks another: removes the follows between them, either way, and every save alert naming either to the other; sale alerts between them keep the sale without the buyer''s name.';

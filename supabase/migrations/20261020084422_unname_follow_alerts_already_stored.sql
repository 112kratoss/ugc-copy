-- The follow alerts stored before 20261020072851 that it would have unnamed:
-- those whose follower's account is gone (the foreign key cleared
-- actor_user_id and left the handle in the words), and those across a block
-- made before it.
--
-- In its own migration, after that one commits. A block already running the
-- earlier remove_follows_for_user_block when 20261020072851 took its lock
-- finishes with that body, which leaves follow alerts as they are, and that
-- migration could not see the block. Such a block holds mobile_notifications
-- until it commits, so the lock taken here waits for it, and this repair then
-- finds its alerts.
--
-- The trigger that stamps updated_at is set aside, as 20261019211233 set it
-- aside, so the repair does not restart read-alert retention; one statement,
-- so a failed repair cannot leave it off.

SET LOCAL lock_timeout = '5s';

DO $repair$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
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

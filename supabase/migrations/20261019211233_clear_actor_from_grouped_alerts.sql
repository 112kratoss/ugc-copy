-- Clears the actor from the anonymous "Someone saved your post" and "Someone
-- shared your post" alerts written before 20261019122652, which stores none on
-- them from then on. In its own migration, so the locks that file takes are
-- not held for this update.
--
-- The trigger is set aside so the repair does not stamp updated_at (which
-- read-alert retention counts from); one statement, so a failed repair cannot
-- leave it off.

SET LOCAL lock_timeout = '5s';

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

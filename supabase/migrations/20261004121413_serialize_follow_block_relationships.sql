-- Keep the existing triggers and service-only grants; serialize their decisions
-- so a block cannot miss a follow that is still uncommitted, in either direction.

CREATE OR REPLACE FUNCTION public.reject_blocked_user_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Both directions share one transaction lock with block persistence.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'follow-block:' || least(NEW.follower_id, NEW.following_id)::text || ':' ||
    greatest(NEW.follower_id, NEW.following_id)::text, 0
  ));

  IF EXISTS (
    SELECT 1
    FROM public.user_blocks AS block
    WHERE (
      block.blocker_user_id = NEW.follower_id
      AND block.blocked_user_id = NEW.following_id
    ) OR (
      block.blocker_user_id = NEW.following_id
      AND block.blocked_user_id = NEW.follower_id
    )
  ) THEN
    RAISE EXCEPTION 'Follow relationship is unavailable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.reject_blocked_user_follow() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_blocked_user_follow() TO service_role;

CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Wait for any admitted follow to commit before removing it. The opposite
  -- ordering makes the follow trigger observe this block after its lock wait.
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

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.remove_follows_for_user_block() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follows_for_user_block() TO service_role;


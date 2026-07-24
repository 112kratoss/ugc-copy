-- Route all follow mutations through the authenticated backend. The legacy
-- client policies allowed direct PostgREST writes that bypassed block checks.
DROP POLICY IF EXISTS "Users can insert their own follows." ON public.follows;
DROP POLICY IF EXISTS "Users can delete their own follows." ON public.follows;

REVOKE ALL ON TABLE public.follows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.follows TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.follows TO service_role;

-- Content reports increment public moderation counters. Keep them behind the
-- rate-limited backend instead of accepting direct Data API inserts.
DROP POLICY IF EXISTS "Users can insert post reports" ON public.post_reports;
DROP POLICY IF EXISTS "Users can view their own post reports" ON public.post_reports;

REVOKE ALL ON TABLE public.post_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_reports TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.post_reports'::regclass
      AND conname = 'post_reports_details_length'
  ) THEN
    ALTER TABLE public.post_reports
      ADD CONSTRAINT post_reports_details_length
      CHECK (details IS NULL OR char_length(details) <= 1000)
      NOT VALID;
  END IF;
END
$$;

-- Remove legacy relationships that predate blocking enforcement.
DELETE FROM public.follows AS follow
USING public.user_blocks AS block
WHERE (
  follow.follower_id = block.blocker_user_id
  AND follow.following_id = block.blocked_user_id
) OR (
  follow.follower_id = block.blocked_user_id
  AND follow.following_id = block.blocker_user_id
);

CREATE OR REPLACE FUNCTION public.reject_blocked_user_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS follows_reject_blocked_relationship ON public.follows;
CREATE TRIGGER follows_reject_blocked_relationship
BEFORE INSERT OR UPDATE OF follower_id, following_id ON public.follows
FOR EACH ROW
EXECUTE FUNCTION public.reject_blocked_user_follow();

CREATE OR REPLACE FUNCTION public.remove_follows_for_user_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS user_blocks_remove_follows ON public.user_blocks;
CREATE TRIGGER user_blocks_remove_follows
AFTER INSERT OR UPDATE ON public.user_blocks
FOR EACH ROW
EXECUTE FUNCTION public.remove_follows_for_user_block();

COMMENT ON FUNCTION public.reject_blocked_user_follow() IS
  'Rejects follow writes when either user has blocked the other.';

COMMENT ON FUNCTION public.remove_follows_for_user_block() IS
  'Atomically removes follows in both directions whenever a user block is persisted.';

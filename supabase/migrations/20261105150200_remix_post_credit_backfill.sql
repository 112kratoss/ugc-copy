-- The posts made before 20261105150143_remix_posts_carry_their_credit.sql take
-- their credit, in a transaction of its own so that migration's table locks are
-- not held through it. As a function, so pgTAP can run it over seeded rows; a
-- second run changes nothing.
--
-- Oldest first, so a remix of a remix reads its parent's origin already filled.
-- Each post is asked by naming the credit columns in an update, which the trigger
-- answers for a post with no credit yet and ignores for one that has it.
-- A post whose owner has an account deletion job is left alone: the content freeze
-- (reject_post_write_during_account_deletion) refuses a write to it, which would
-- fail this migration and the release, and the deletion removes it anyway.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.backfill_remix_post_credit()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_post record;
BEGIN
  FOR v_post IN
    SELECT p.id
    FROM public.posts AS p
    WHERE p.generation_id IS NOT NULL
      AND p.remix_parent_post_id IS NULL
      AND p.remix_parent_user_id IS NULL
      AND p.remix_origin_user_id IS NULL
      AND EXISTS (SELECT 1 FROM public.remix_credit_for_generation(p.generation_id))
      AND NOT public.is_account_deletion_requested(p.user_id)
    ORDER BY p.created_at, p.id
  LOOP
    UPDATE public.posts
    SET remix_parent_post_id = NULL
    WHERE id = v_post.id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_remix_post_credit() FROM PUBLIC, anon, authenticated;

SELECT public.backfill_remix_post_credit();

COMMIT;

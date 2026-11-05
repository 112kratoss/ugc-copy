-- The creations and posts made before 20261105150143_remix_posts_carry_their_credit.sql
-- take their credit, in a transaction of its own so that migration's table locks
-- are not held through it. As a function, so pgTAP can run it over seeded rows; a
-- second run changes nothing.
--
-- 1. Creations first, oldest first: a re-run then finds the credit of the run it
--    was made from already recorded, and a remix of a remix its parent's origin.
--    Recorded now, a creation's credit outlives the rows it was read from, so a
--    remixer who deletes a run after this keeps the credit of the runs made from
--    it.
-- 2. Then posts, oldest first, from their creations' credit.
-- Each row is asked by naming the credit columns in an update, which its table's
-- trigger answers for a row with no credit yet and ignores for one that has it.
-- Only a row that has a credit to take is written.
-- A post whose owner has an account deletion job is left alone: the content freeze
-- (reject_post_write_during_account_deletion) refuses a write to it, and the
-- deletion removes it anyway. A job that begins while this runs is met the same
-- way, row by row, instead of failing the migration and the release.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.backfill_remix_post_credit()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_run record;
  v_post record;
BEGIN
  FOR v_run IN
    SELECT g.id
    FROM public.generations AS g
    WHERE g.remix_parent_post_id IS NULL
      AND g.remix_parent_user_id IS NULL
      AND g.remix_origin_user_id IS NULL
      AND (
        g.source_generation_id IS NOT NULL
        OR g.remix_origin_generation_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.completed_post_remixes AS remix WHERE remix.generation_id = g.id)
      )
    ORDER BY g.created_at, g.id
  LOOP
    IF EXISTS (SELECT 1 FROM public.remix_credit_for_generation(v_run.id)) THEN
      UPDATE public.generations
      SET remix_parent_post_id = NULL
      WHERE id = v_run.id;
    END IF;
  END LOOP;

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
    BEGIN
      UPDATE public.posts
      SET remix_parent_post_id = NULL
      WHERE id = v_post.id;
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      -- An account deletion begun since the row was read.
      NULL;
    END;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_remix_post_credit() FROM PUBLIC, anon, authenticated;

SELECT public.backfill_remix_post_credit();

COMMIT;

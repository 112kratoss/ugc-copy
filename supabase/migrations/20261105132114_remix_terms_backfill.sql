-- The rows written before 20261105123244_remix_runs_record_their_recipe_terms.sql,
-- brought under its rules, in a transaction of its own so that migration's
-- table locks are not held through it. As a function, so pgTAP can run it over
-- seeded rows; it changes nothing a second run would change again.
--
-- 1. Every remix run, oldest first so each inherits from a source already filled:
--    its terms by remix_terms_for, which reads purchases, so a run is paid where
--    its maker paid for the recipe it remixed and free where they took it free or
--    remixed an open post. What the source looked like then was never kept, and a
--    purchase is the one record of it.
-- 2. Their posts take the mode.
-- 3. A paid version shows no prompt on its post (posts.prompt), as publish now
--    keeps it.
-- 4. The remixes the post's own owner made, which no longer count, go; each takes
--    one off its post's remix_count through forget_completed_post_remix.
-- A post whose owner has an account deletion job is left alone: the content freeze
-- (reject_post_write_during_account_deletion) refuses a write to it, which would
-- fail this migration and the release, and the deletion removes it anyway.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.backfill_remix_recipe_terms()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_run record;
  v_terms record;
BEGIN
  FOR v_run IN
    SELECT g.id, g.user_id, g.source_generation_id
    FROM public.generations AS g
    WHERE g.source_generation_id IS NOT NULL
    ORDER BY g.created_at, g.id
  LOOP
    SELECT * INTO v_terms FROM public.remix_terms_for(v_run.user_id, v_run.source_generation_id);
    IF FOUND THEN
      UPDATE public.generations
      SET remix_recipe_mode = v_terms.mode,
          remix_recipe_bundle_id = v_terms.bundle_id,
          remix_origin_generation_id = v_terms.origin_generation_id
      WHERE id = v_run.id
        AND (remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id)
          IS DISTINCT FROM (v_terms.mode, v_terms.bundle_id, v_terms.origin_generation_id);
    END IF;
  END LOOP;

  UPDATE public.posts AS p
  SET remix_recipe_mode = g.remix_recipe_mode
  FROM public.generations AS g
  WHERE g.id = p.generation_id
    AND g.remix_recipe_mode IS NOT NULL
    AND p.remix_recipe_mode IS DISTINCT FROM g.remix_recipe_mode
    AND NOT public.is_account_deletion_requested(p.user_id);

  UPDATE public.posts AS p
  SET prompt = NULL
  WHERE p.remix_recipe_mode = 'paid'
    AND p.prompt IS NOT NULL
    AND NOT public.is_account_deletion_requested(p.user_id);

  DELETE FROM public.completed_post_remixes AS remix
  USING public.posts AS p
  WHERE p.id = remix.post_id
    AND remix.actor_user_id IN (SELECT public.linked_account_ids(p.user_id))
    AND NOT public.is_account_deletion_requested(p.user_id);
END;
$$;
REVOKE ALL ON FUNCTION public.backfill_remix_recipe_terms() FROM PUBLIC, anon, authenticated;

SELECT public.backfill_remix_recipe_terms();

COMMIT;

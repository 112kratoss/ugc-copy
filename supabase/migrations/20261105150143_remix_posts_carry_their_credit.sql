-- A remix post carries its credit (remix plan, phase 3; owner, 2026-11-05: "Remix
-- of 'title' by @A" on every remix post, "· Original by @A" when the chain began
-- with someone else, added automatically and never removable by the remixer).
--
-- 1. Three columns on posts, written only by the trigger below:
--      remix_parent_post_id  the post the creation remixed: its run's row in
--                            completed_post_remixes, or, for a run from its
--                            maker's own creation (a re-run, a self-remix), the
--                            row of the remix it came from, as remix_terms_for
--                            passes the terms down.
--      remix_parent_user_id  that post's creator, so a feed page reads the name
--                            beside its creators' and not after the post.
--      remix_origin_user_id  the chain's first creator: the parent post's own
--                            origin, else the parent post's creator; with no
--                            parent post to read, the creator of the run's
--                            remix_origin_generation_id (20261105123244).
--    All three are plain references with no foreign key, as that migration's are:
--    a post or account deleted later leaves them, scans nothing and rewrites
--    nothing. Readers answer a missing post or person by leaving that part out.
-- 2. The credit is written when a post is made from its creation and then stays:
--    an update writes nothing to it, and deleting the creation (ON DELETE SET
--    NULL on posts.generation_id) leaves it on the post, so a remixer who deletes
--    their creation keeps the post's credit. Only a post with no credit yet is
--    worked out again when an update names those columns, which is how
--    20261105150200_remix_post_credit_backfill.sql fills the posts made before.
-- 3. An index for the remixes a post lists (GET /api/showcase/posts/:id/remixes).
-- It runs inside lock_timeout; the backfill is a migration of its own so these
-- locks are not held through it.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS remix_parent_post_id uuid,
  ADD COLUMN IF NOT EXISTS remix_parent_user_id uuid,
  ADD COLUMN IF NOT EXISTS remix_origin_user_id uuid;

COMMENT ON COLUMN public.posts.remix_parent_post_id IS
  'The post this post''s creation remixed; no foreign key. Written by copy_generation_remix_credit_to_post only.';
COMMENT ON COLUMN public.posts.remix_parent_user_id IS
  'The creator of remix_parent_post_id when the credit was written; no foreign key. Written by copy_generation_remix_credit_to_post only.';
COMMENT ON COLUMN public.posts.remix_origin_user_id IS
  'The first creator of this post''s remix chain; no foreign key. Written by copy_generation_remix_credit_to_post only.';

-- The credit a post of p_generation_id carries. No row for a creation that is not
-- a remix of anyone's post.
CREATE OR REPLACE FUNCTION public.remix_credit_for_generation(p_generation_id uuid)
RETURNS TABLE (parent_post_id uuid, parent_user_id uuid, origin_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_current uuid := p_generation_id;
  v_steps integer := 0;
  v_origin_generation_id uuid;
  v_parent_post_id uuid;
  v_parent_user_id uuid;
  v_parent_origin_user_id uuid;
  v_run_user_id uuid;
  v_run_source_id uuid;
  v_source_user_id uuid;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN;
  END IF;

  SELECT g.remix_origin_generation_id INTO v_origin_generation_id
  FROM public.generations AS g
  WHERE g.id = p_generation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The remix ledger names the post a finished run remixed. A run from its
  -- maker's own creation has no row of its own (20261105123244 stopped counting
  -- those), so it takes the row of the creation it was made from, back through
  -- the maker's own creations only. Twenty steps is more re-runs of one remix
  -- than anyone makes; the walk ends there rather than on a loop.
  LOOP
    SELECT p.id, p.user_id, p.remix_origin_user_id
    INTO v_parent_post_id, v_parent_user_id, v_parent_origin_user_id
    FROM public.completed_post_remixes AS remix
    JOIN public.posts AS p ON p.id = remix.post_id
    WHERE remix.generation_id = v_current;
    EXIT WHEN FOUND;

    SELECT g.user_id, g.source_generation_id INTO v_run_user_id, v_run_source_id
    FROM public.generations AS g
    WHERE g.id = v_current;
    EXIT WHEN NOT FOUND OR v_run_source_id IS NULL OR v_steps >= 20;

    SELECT s.user_id INTO v_source_user_id
    FROM public.generations AS s
    WHERE s.id = v_run_source_id;
    EXIT WHEN NOT FOUND OR v_source_user_id IS NULL
      OR v_source_user_id NOT IN (SELECT public.linked_account_ids(v_run_user_id));

    v_current := v_run_source_id;
    v_steps := v_steps + 1;
  END LOOP;

  IF v_parent_post_id IS NOT NULL THEN
    RETURN QUERY SELECT v_parent_post_id, v_parent_user_id, coalesce(v_parent_origin_user_id, v_parent_user_id);
    RETURN;
  END IF;

  -- No post to name (it was deleted, or the remix was never credited to one):
  -- the chain's first creator still is, under the account a guest creator
  -- linked to.
  IF v_origin_generation_id IS NOT NULL THEN
    RETURN QUERY
      SELECT NULL::uuid, NULL::uuid, coalesce(owner.merged_into_user_id, origin.user_id)
      FROM public.generations AS origin
      LEFT JOIN public.profiles AS owner ON owner.id = origin.user_id
      WHERE origin.id = v_origin_generation_id
        AND origin.user_id IS NOT NULL;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.remix_credit_for_generation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_credit_for_generation(uuid) TO service_role;

-- A post takes its creation's credit when it is made from it and keeps it. Only a
-- post with no credit yet is asked again (an update naming the columns, or a new
-- creation on the post); one with a credit keeps it through any update, and
-- through its creation's deletion.
CREATE OR REPLACE FUNCTION public.copy_generation_remix_credit_to_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_credit record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND num_nonnulls(OLD.remix_parent_post_id, OLD.remix_parent_user_id, OLD.remix_origin_user_id) > 0
    AND (NEW.generation_id IS NULL OR NEW.generation_id IS NOT DISTINCT FROM OLD.generation_id) THEN
    NEW.remix_parent_post_id := OLD.remix_parent_post_id;
    NEW.remix_parent_user_id := OLD.remix_parent_user_id;
    NEW.remix_origin_user_id := OLD.remix_origin_user_id;
    RETURN NEW;
  END IF;

  NEW.remix_parent_post_id := NULL;
  NEW.remix_parent_user_id := NULL;
  NEW.remix_origin_user_id := NULL;
  IF NEW.generation_id IS NOT NULL THEN
    SELECT * INTO v_credit FROM public.remix_credit_for_generation(NEW.generation_id);
    -- A post never credits itself.
    IF FOUND AND v_credit.parent_post_id IS DISTINCT FROM NEW.id THEN
      NEW.remix_parent_post_id := v_credit.parent_post_id;
      NEW.remix_parent_user_id := v_credit.parent_user_id;
      NEW.remix_origin_user_id := v_credit.origin_user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.copy_generation_remix_credit_to_post() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_copy_remix_credit ON public.posts;
CREATE TRIGGER posts_copy_remix_credit
BEFORE INSERT OR UPDATE OF generation_id, remix_parent_post_id, remix_parent_user_id, remix_origin_user_id
ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.copy_generation_remix_credit_to_post();

-- A post's remixes, newest first, as the list pages them.
CREATE INDEX IF NOT EXISTS posts_remix_parent_post_idx
  ON public.posts (remix_parent_post_id, created_at DESC, id DESC)
  WHERE remix_parent_post_id IS NOT NULL;

COMMIT;

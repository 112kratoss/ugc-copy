-- A remix post carries its credit (remix plan, phase 3; owner, 2026-11-05: "Remix
-- of 'title' by @A" on every remix post, "· Original by @A" when the chain began
-- with someone else, added automatically and never removable by the remixer).
--
-- 1. The same three columns on posts and on generations, written only by the
--    triggers below:
--      remix_parent_post_id  the post the creation remixed.
--      remix_parent_user_id  that post's creator, so a feed page reads the name
--                            beside its creators' and not after the post.
--      remix_origin_user_id  the chain's first creator: the parent post's own
--                            origin, else the parent post's creator; with no
--                            parent post to name, the creator of the creation the
--                            run was made from (or of that one's origin).
--    All six are plain references with no foreign key, as 20261105123244's are:
--    a post, creation or account deleted later leaves them, scans nothing and
--    rewrites nothing. Readers answer a missing post or person by leaving that
--    part out.
-- 2. A creation records its credit when it is made, as remix terms are recorded
--    (20261105123244): a run from someone else's creation names that creation's
--    public post (posted by its maker, or by the account a guest maker linked to);
--    a run from the maker's own creation (a re-run, a self-remix, by them or a
--    guest linked to them) takes the credit that creation carries. It
--    stays: deleting the source clears source_generation_id (ON DELETE SET NULL)
--    and the source's row in completed_post_remixes (ON DELETE CASCADE), and
--    neither takes the credit with it. So a remixer who re-runs their remix,
--    deletes the first run and posts the re-run still credits the post they
--    remixed.
-- 3. A post takes its creation's credit when it is made from it and then keeps
--    it: an update writes nothing to it, and deleting the creation (ON DELETE SET
--    NULL on posts.generation_id) leaves it on the post.
-- 4. A row with no credit yet, on either table, is worked out again when an
--    update names those columns, from what it records, the remix ledger
--    (completed_post_remixes) and the maker's own creations it came from. That is
--    how 20261105175341_remix_post_credit_backfill.sql fills the rows made before.
-- 5. An index for the remixes a post lists (GET /api/showcase/posts/:id/remixes).
-- It runs inside lock_timeout; the backfill is a migration of its own so these
-- locks are not held through it.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then generations: the order the edit path takes them in
-- (posts_sync_generation_exposure), as 20261105123244 does.
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

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS remix_parent_post_id uuid,
  ADD COLUMN IF NOT EXISTS remix_parent_user_id uuid,
  ADD COLUMN IF NOT EXISTS remix_origin_user_id uuid;

COMMENT ON COLUMN public.generations.remix_parent_post_id IS
  'The post this run remixed, or the one its maker''s own source remixed, kept when the source is deleted; no foreign key. Written by record_generation_remix_credit only.';
COMMENT ON COLUMN public.generations.remix_parent_user_id IS
  'The creator of remix_parent_post_id when the run was made; no foreign key. Written by record_generation_remix_credit only.';
COMMENT ON COLUMN public.generations.remix_origin_user_id IS
  'The first creator of this run''s remix chain; no foreign key. Written by record_generation_remix_credit only.';

-- The credit a remix of p_source_generation_id names: the public post it was posted
-- as, by its maker or by the account a guest maker linked to (publish files a
-- guest's creation under the account), as the remix ledger finds it
-- (record_completed_post_remix). The parent's origin is that post's own, or the
-- one its creation recorded (the post may not have its own yet while the backfill
-- fills creations first). No row for a creation with no public post.
CREATE OR REPLACE FUNCTION public.remix_credit_from_source_post(p_source_generation_id uuid)
RETURNS TABLE (parent_post_id uuid, parent_user_id uuid, origin_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.user_id, coalesce(p.remix_origin_user_id, source.remix_origin_user_id, p.user_id)
  FROM public.generations AS source
  JOIN public.posts AS p ON p.generation_id = source.id
  WHERE source.id = p_source_generation_id
    AND p.visibility = 'public'
    AND (
      p.user_id = source.user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = source.user_id
          AND owner.merged_into_user_id = p.user_id
      )
    )
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.remix_credit_from_source_post(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_credit_from_source_post(uuid) TO service_role;

-- The credit a creation carries: what it recorded when it was made, else, for a
-- creation made before creations recorded one, the remix ledger's row for it or
-- for the maker's own creation it came from, or, for a run from someone else's
-- creation that has no ledger row yet (one still running), that creation's
-- public post. A recorded credit that names no post gives way to a ledger row
-- that does. No row for a creation that is not a remix of anyone's.
CREATE OR REPLACE FUNCTION public.remix_credit_for_generation(p_generation_id uuid)
RETURNS TABLE (parent_post_id uuid, parent_user_id uuid, origin_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_current uuid := p_generation_id;
  v_steps integer := 0;
  v_origin_generation_id uuid;
  v_run record;
  v_parent record;
  v_ledger boolean;
  v_source_user_id uuid;
BEGIN
  IF p_generation_id IS NULL THEN
    RETURN;
  END IF;

  -- Back through the maker's own creations only. Twenty steps is more re-runs of
  -- one remix than anyone makes; the walk ends there rather than on a loop.
  LOOP
    SELECT g.user_id, g.source_generation_id, g.remix_origin_generation_id,
      g.remix_parent_post_id, g.remix_parent_user_id, g.remix_origin_user_id
    INTO v_run
    FROM public.generations AS g
    WHERE g.id = v_current;
    EXIT WHEN NOT FOUND;
    IF v_steps = 0 THEN
      v_origin_generation_id := v_run.remix_origin_generation_id;
    END IF;

    -- The remix ledger names the post a finished run remixed. A run from its
    -- maker's own creation has no row of its own (20261105123244 stopped counting
    -- those), so it takes the row of the creation it was made from.
    SELECT p.id, p.user_id,
      coalesce(p.remix_origin_user_id, parent_run.remix_origin_user_id, p.user_id) AS origin_user_id
    INTO v_parent
    FROM public.completed_post_remixes AS remix
    JOIN public.posts AS p ON p.id = remix.post_id
    LEFT JOIN public.generations AS parent_run ON parent_run.id = p.generation_id
    WHERE remix.generation_id = v_current;
    v_ledger := FOUND;

    -- What the creation recorded when it was made (record_generation_remix_credit),
    -- unless it names no post and the ledger names one.
    IF num_nonnulls(v_run.remix_parent_post_id, v_run.remix_parent_user_id, v_run.remix_origin_user_id) > 0
      AND (v_run.remix_parent_post_id IS NOT NULL OR NOT v_ledger) THEN
      RETURN QUERY SELECT v_run.remix_parent_post_id, v_run.remix_parent_user_id, v_run.remix_origin_user_id;
      RETURN;
    END IF;
    IF v_ledger THEN
      RETURN QUERY SELECT v_parent.id, v_parent.user_id, v_parent.origin_user_id;
      RETURN;
    END IF;

    EXIT WHEN v_run.source_generation_id IS NULL OR v_run.user_id IS NULL OR v_steps >= 20;
    SELECT s.user_id INTO v_source_user_id
    FROM public.generations AS s
    WHERE s.id = v_run.source_generation_id;
    EXIT WHEN NOT FOUND OR v_source_user_id IS NULL;

    IF NOT EXISTS (
      SELECT 1 FROM public.linked_account_ids(v_run.user_id) AS linked(id) WHERE linked.id = v_source_user_id
    ) THEN
      -- Someone else's creation, and no ledger row for this run yet: the public
      -- post it was remixed from, as a run made now records it.
      SELECT * INTO v_parent FROM public.remix_credit_from_source_post(v_run.source_generation_id);
      IF FOUND THEN
        RETURN QUERY SELECT v_parent.parent_post_id, v_parent.parent_user_id, v_parent.origin_user_id;
        RETURN;
      END IF;
      EXIT;
    END IF;

    v_current := v_run.source_generation_id;
    v_steps := v_steps + 1;
  END LOOP;

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

-- The credit a run started by p_user_id from p_source_generation_id records when it
-- is made. No row for a run with no source.
CREATE OR REPLACE FUNCTION public.remix_credit_for_run(p_user_id uuid, p_source_generation_id uuid)
RETURNS TABLE (parent_post_id uuid, parent_user_id uuid, origin_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_source record;
  v_parent record;
BEGIN
  IF p_source_generation_id IS NULL THEN
    RETURN;
  END IF;

  SELECT g.id, g.user_id, g.remix_origin_user_id
  INTO v_source
  FROM public.generations AS g
  WHERE g.id = p_source_generation_id;
  IF NOT FOUND OR v_source.user_id IS NULL THEN
    RETURN;
  END IF;

  -- The caller's own creation, or one made as a guest since linked to them: the
  -- credit it carries, as remix terms pass down.
  IF EXISTS (
    SELECT 1 FROM public.linked_account_ids(p_user_id) AS linked(id) WHERE linked.id = v_source.user_id
  ) THEN
    RETURN QUERY SELECT * FROM public.remix_credit_for_generation(v_source.id);
    RETURN;
  END IF;

  -- Someone else's creation: the public post it was remixed from.
  SELECT * INTO v_parent FROM public.remix_credit_from_source_post(v_source.id);
  IF FOUND THEN
    RETURN QUERY SELECT v_parent.parent_post_id, v_parent.parent_user_id, v_parent.origin_user_id;
    RETURN;
  END IF;

  -- No public post to name: the chain's first creator still is, under the
  -- account a guest creator linked to.
  RETURN QUERY
    SELECT NULL::uuid, NULL::uuid, coalesce(v_source.remix_origin_user_id, owner.merged_into_user_id, v_source.user_id)
    FROM (SELECT v_source.user_id AS user_id) AS source
    LEFT JOIN public.profiles AS owner ON owner.id = source.user_id;
END;
$$;
REVOKE ALL ON FUNCTION public.remix_credit_for_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_credit_for_run(uuid, uuid) TO service_role;

-- An insert records the credit from its source, discarding anything the insert
-- sent for it. An update records it again only for a new source; one that clears
-- the source (its creation deleted) or leaves it keeps it. A run with no credit
-- yet is worked out again from what it was made from.
CREATE OR REPLACE FUNCTION public.record_generation_remix_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_credit record;
  v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (NEW.source_generation_id IS NULL OR NEW.source_generation_id IS NOT DISTINCT FROM OLD.source_generation_id) THEN
    IF num_nonnulls(OLD.remix_parent_post_id, OLD.remix_parent_user_id, OLD.remix_origin_user_id) > 0 THEN
      NEW.remix_parent_post_id := OLD.remix_parent_post_id;
      NEW.remix_parent_user_id := OLD.remix_parent_user_id;
      NEW.remix_origin_user_id := OLD.remix_origin_user_id;
      RETURN NEW;
    END IF;
    SELECT * INTO v_credit FROM public.remix_credit_for_generation(NEW.id);
    v_found := FOUND;
  ELSE
    SELECT * INTO v_credit FROM public.remix_credit_for_run(NEW.user_id, NEW.source_generation_id);
    v_found := FOUND;
  END IF;

  NEW.remix_parent_post_id := NULL;
  NEW.remix_parent_user_id := NULL;
  NEW.remix_origin_user_id := NULL;
  IF v_found THEN
    NEW.remix_parent_post_id := v_credit.parent_post_id;
    NEW.remix_parent_user_id := v_credit.parent_user_id;
    NEW.remix_origin_user_id := v_credit.origin_user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_generation_remix_credit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS generations_record_remix_credit ON public.generations;
CREATE TRIGGER generations_record_remix_credit
BEFORE INSERT OR UPDATE OF source_generation_id, remix_parent_post_id, remix_parent_user_id, remix_origin_user_id
ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.record_generation_remix_credit();

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

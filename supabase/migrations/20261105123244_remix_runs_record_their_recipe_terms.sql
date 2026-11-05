-- Remix runs record the terms of the recipe they came from (remix plan, phase 1;
-- owner, 2026-11-05: a remix of a paid recipe stays paid, a remix of a free one
-- stays free, and a remix pays the post it remixed in full).
--
-- 1. Three columns on generations, written only by the trigger below:
--      remix_recipe_mode          'free' or 'paid': the terms of the post a run
--                                 remixed. Paid when the caller paid for that
--                                 post's recipe, live or since taken down
--                                 (remix_source_bought_paid), or when the source
--                                 was already a paid version: paid sticks down a
--                                 chain. Free otherwise, a post with no recipe
--                                 included. A run starts from a paid recipe only
--                                 after buying it (remix-access.ts), so a buyer's
--                                 purchase is the whole of what the remix took.
--      remix_recipe_bundle_id     the recipe it remixed, so the files that came
--                                 through it may go on into the remixer's own.
--      remix_origin_generation_id the chain's first creation, for "Original by".
--    The two ids are plain references with no foreign key: deleting a creation or
--    a recipe leaves them as they were, scans nothing and rewrites nothing.
--    A run whose source is the caller's own creation (a self-remix or a re-run, by
--    the caller or a guest linked to them) inherits all three from that source, so
--    nobody escapes the rule by remixing their own version. Once written, the terms
--    stay: deleting the source creation clears source_generation_id (ON DELETE SET
--    NULL), which must not clear them with it. The publish and edit services refuse
--    a recipe that breaks the recorded mode.
-- 2. posts.remix_recipe_mode copies the mode from the post's creation and keeps it
--    after the creation is deleted, so a post that lost its creation is still held
--    to it.
-- 3. record_completed_post_remix stops counting a remix by the post's owner or a
--    guest linked to them (owner, 2026-11-05: "count others only").
--    20261030022210's body otherwise; CREATE OR REPLACE keeps its owner, grants and
--    trigger.
-- The rows written before this are filled in by
-- 20261105132114_remix_terms_backfill.sql, in a transaction of its own so these
-- locks are not held through it.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then generations: the order the edit path takes them in
-- (posts_sync_generation_exposure).
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS remix_recipe_mode text;
ALTER TABLE public.posts
  DROP CONSTRAINT IF EXISTS posts_remix_recipe_mode_check;
ALTER TABLE public.posts
  ADD CONSTRAINT posts_remix_recipe_mode_check
    CHECK (remix_recipe_mode IS NULL OR remix_recipe_mode IN ('free', 'paid'));
COMMENT ON COLUMN public.posts.remix_recipe_mode IS
  'The remix terms of the post''s creation (generations.remix_recipe_mode), kept after the creation is deleted. Written by copy_generation_remix_terms_to_post only.';

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS remix_recipe_mode text,
  ADD COLUMN IF NOT EXISTS remix_recipe_bundle_id uuid,
  ADD COLUMN IF NOT EXISTS remix_origin_generation_id uuid;
ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_remix_recipe_mode_check;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_remix_recipe_mode_check
    CHECK (remix_recipe_mode IS NULL OR remix_recipe_mode IN ('free', 'paid'));

COMMENT ON COLUMN public.generations.remix_recipe_mode IS
  'free or paid: the terms of the post this run remixed, inherited through the caller''s own creations and kept when the source is deleted. Written by record_generation_remix_terms only.';
COMMENT ON COLUMN public.generations.remix_recipe_bundle_id IS
  'The recipe this run remixed, or the one its own source remixed; no foreign key. Written by record_generation_remix_terms only.';
COMMENT ON COLUMN public.generations.remix_origin_generation_id IS
  'The first creation of this run''s remix chain; no foreign key. Written by record_generation_remix_terms only.';

-- Whether p_user_id, or a guest linked to them, paid for the recipe on the post of
-- p_source_generation_id, in whatever state that recipe is now: a recipe its creator
-- took down after selling it still made what its buyers remix paid. A free unlock
-- is a purchase row at price 0, which does not count.
CREATE OR REPLACE FUNCTION public.remix_source_bought_paid(p_user_id uuid, p_source_generation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.posts AS p
    JOIN public.post_resource_bundles AS b ON b.post_id = p.id
    JOIN public.post_resource_bundle_purchases AS purchase ON purchase.bundle_id = b.id
    WHERE p.generation_id = p_source_generation_id
      AND purchase.price_usd_cents > 0
      AND purchase.buyer_user_id IN (SELECT public.linked_account_ids(p_user_id))
  );
$$;
REVOKE ALL ON FUNCTION public.remix_source_bought_paid(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_source_bought_paid(uuid, uuid) TO service_role;

-- The terms a run started by p_user_id from p_source_generation_id carries.
CREATE OR REPLACE FUNCTION public.remix_terms_for(p_user_id uuid, p_source_generation_id uuid)
RETURNS TABLE (mode text, bundle_id uuid, origin_generation_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_source record;
  v_bundle_id uuid;
  v_bundle_status text;
  v_bought_paid boolean;
BEGIN
  IF p_source_generation_id IS NULL THEN
    RETURN;
  END IF;

  SELECT g.id, g.user_id, g.remix_recipe_mode, g.remix_recipe_bundle_id, g.remix_origin_generation_id
  INTO v_source
  FROM public.generations AS g
  WHERE g.id = p_source_generation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The caller's own creation, or one made as a guest since linked to them.
  IF v_source.user_id IN (SELECT public.linked_account_ids(p_user_id)) THEN
    RETURN QUERY SELECT v_source.remix_recipe_mode, v_source.remix_recipe_bundle_id,
      v_source.remix_origin_generation_id;
    RETURN;
  END IF;

  SELECT b.id, b.status
  INTO v_bundle_id, v_bundle_status
  FROM public.posts AS p
  JOIN public.post_resource_bundles AS b ON b.post_id = p.id
  WHERE p.generation_id = v_source.id
  LIMIT 1;
  v_bought_paid := public.remix_source_bought_paid(p_user_id, v_source.id);

  RETURN QUERY SELECT
    CASE WHEN v_bought_paid OR v_source.remix_recipe_mode = 'paid' THEN 'paid' ELSE 'free' END,
    CASE WHEN v_bundle_status = 'published' OR v_bought_paid THEN v_bundle_id END,
    coalesce(v_source.remix_origin_generation_id, v_source.id);
END;
$$;
REVOKE ALL ON FUNCTION public.remix_terms_for(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remix_terms_for(uuid, uuid) TO service_role;

-- An insert writes the three columns from its source, discarding anything the
-- insert sent for them. An update rewrites them only for a new source; one that
-- clears the source (its creation deleted) or leaves it keeps them.
CREATE OR REPLACE FUNCTION public.record_generation_remix_terms()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_terms record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (NEW.source_generation_id IS NULL OR NEW.source_generation_id IS NOT DISTINCT FROM OLD.source_generation_id) THEN
    NEW.remix_recipe_mode := OLD.remix_recipe_mode;
    NEW.remix_recipe_bundle_id := OLD.remix_recipe_bundle_id;
    NEW.remix_origin_generation_id := OLD.remix_origin_generation_id;
    RETURN NEW;
  END IF;

  NEW.remix_recipe_mode := NULL;
  NEW.remix_recipe_bundle_id := NULL;
  NEW.remix_origin_generation_id := NULL;

  SELECT * INTO v_terms FROM public.remix_terms_for(NEW.user_id, NEW.source_generation_id);
  IF FOUND THEN
    NEW.remix_recipe_mode := v_terms.mode;
    NEW.remix_recipe_bundle_id := v_terms.bundle_id;
    NEW.remix_origin_generation_id := v_terms.origin_generation_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_generation_remix_terms() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS generations_record_remix_terms ON public.generations;
CREATE TRIGGER generations_record_remix_terms
BEFORE INSERT OR UPDATE OF source_generation_id ON public.generations
FOR EACH ROW EXECUTE FUNCTION public.record_generation_remix_terms();

-- The post keeps its creation's mode, past the creation's deletion, from nothing a
-- caller writes to the column.
CREATE OR REPLACE FUNCTION public.copy_generation_remix_terms_to_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.generation_id IS NOT NULL THEN
    NEW.remix_recipe_mode := (
      SELECT g.remix_recipe_mode FROM public.generations AS g WHERE g.id = NEW.generation_id
    );
  ELSIF TG_OP = 'INSERT' THEN
    NEW.remix_recipe_mode := NULL;
  ELSE
    NEW.remix_recipe_mode := OLD.remix_recipe_mode;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.copy_generation_remix_terms_to_post() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_copy_remix_terms ON public.posts;
CREATE TRIGGER posts_copy_remix_terms
BEFORE INSERT OR UPDATE OF generation_id, remix_recipe_mode ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.copy_generation_remix_terms_to_post();

-- A remix counts only when someone other than the post's owner made it.
CREATE OR REPLACE FUNCTION public.record_completed_post_remix()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_post_id uuid;
  v_inserted_id uuid;
BEGIN
  IF NEW.status <> 'succeeded' OR NEW.source_generation_id IS NULL
    OR nullif(trim(NEW.output_url), '') IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.id INTO v_post_id
  FROM public.posts p JOIN public.generations source ON source.id = p.generation_id
  WHERE p.generation_id = NEW.source_generation_id
    AND (
      p.user_id = source.user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles AS owner
        WHERE owner.id = source.user_id
          AND owner.merged_into_user_id = p.user_id
      )
    )
    AND p.visibility = 'public'
    AND NEW.user_id NOT IN (SELECT public.linked_account_ids(p.user_id));
  IF v_post_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO public.completed_post_remixes(generation_id, post_id, actor_user_id, completed_at)
  VALUES (NEW.id, v_post_id, NEW.user_id, coalesce(NEW.completed_at, now()))
  ON CONFLICT (generation_id) DO NOTHING
  RETURNING generation_id INTO v_inserted_id;
  IF v_inserted_id IS NOT NULL THEN
    UPDATE public.posts SET remix_count = remix_count + 1 WHERE id = v_post_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_completed_post_remix() FROM PUBLIC, anon, authenticated;

COMMIT;

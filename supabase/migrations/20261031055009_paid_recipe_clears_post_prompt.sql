-- A post whose recipe is paid stores no prompt (the owner's decision,
-- 2026-10-31).
--
-- posts.prompt holds the prompt a creator chose to show on a post. Once the
-- post's recipe is paid, that text is what the recipe sells. The feed, the
-- post page and search results blank it while the recipe exists
-- (sanitizePublicPostContent), but the column is still read where no reader
-- applies that rule:
--   - the public search document: refresh_post_search_documents puts the
--     prompt in search_text and search_vector, and search_public_posts
--     matches queries against them;
--   - the feed embedding (supabase/functions/embed-post);
--   - a sold recipe that is removed is kept as a retired draft
--     (20261027172920), and a post whose recipe is a draft is served with
--     its stored prompt.
-- So the column itself is emptied and kept empty:
--
-- 1. A recipe saved as paid, or made paid, clears its post's prompt. A paid
--    draft counts: setting a price is choosing to sell the prompt, and a
--    retired sold recipe is a draft. A free recipe leaves the prompt alone.
-- 2. A later write of the prompt of a post whose recipe is paid is dropped.
--    The publish route still writes a post's prompt: a visibility change
--    carries the stored one forward, and the API still accepts
--    exposePromptPublic, though no composer sends it.
-- 3. The posts that already break the rule are cleared. Production had none
--    on 2026-10-31.
--
-- Clearing is an UPDATE OF prompt on posts, so the search document is
-- re-projected (posts_refresh_public_search_document), updated_at moves
-- (posts_set_updated_at) and the feed-embeddings job re-embeds the post, and
-- on an NSFW post an open reveal ends (advance_nsfw_revision), as any edit of
-- its text does.
--
-- The clear is permanent. No composer writes a post's prompt any more, so
-- only the posts that still carry one from before can lose it: 7 in
-- production on 2026-10-31, none with a recipe, each with its creation.
-- Removing a recipe still opens Remix, which gives the creation's own prompt
-- (what the remove-recipe dialogs promise), but the post's own Prompt box
-- does not come back. The recipe keeps its own copy.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes: the order the publish and edit routes take
-- (they lock the post, then write its recipe), so this cannot deadlock with
-- them. SHARE ROW EXCLUSIVE is what CREATE TRIGGER takes; reads go on beside
-- it. The triggers are made with CREATE OR REPLACE, never DROP TRIGGER, whose
-- ACCESS EXCLUSIVE lock would stop the feed's reads of posts.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. A recipe made paid clears its post's prompt ─────────────────────────

CREATE OR REPLACE FUNCTION public.clear_post_prompt_for_paid_recipe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Lock the post first. A write of its prompt running at the same time then
  -- waits for this recipe to commit and sees it (step 2), rather than
  -- finding no paid recipe and storing the prompt after this clear.
  PERFORM 1
  FROM public.posts
  WHERE id = NEW.post_id
  FOR UPDATE;

  UPDATE public.posts
  SET prompt = NULL
  WHERE id = NEW.post_id
    AND prompt IS NOT NULL;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_post_prompt_for_paid_recipe()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.clear_post_prompt_for_paid_recipe() IS
  'Recipe trigger: a recipe saved as paid clears the prompt its post stored (owner decision, 2026-10-31).';

CREATE OR REPLACE TRIGGER post_resource_bundles_clear_post_prompt_when_paid
AFTER INSERT OR UPDATE OF access_mode, post_id ON public.post_resource_bundles
FOR EACH ROW
WHEN (NEW.access_mode = 'paid')
EXECUTE FUNCTION public.clear_post_prompt_for_paid_recipe();

-- ─── 2. A post whose recipe is paid takes no prompt ─────────────────────────

CREATE OR REPLACE FUNCTION public.keep_post_prompt_out_of_paid_recipe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.post_resource_bundles
    WHERE post_id = NEW.id
      AND access_mode = 'paid'
  ) THEN
    NEW.prompt := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.keep_post_prompt_out_of_paid_recipe()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.keep_post_prompt_out_of_paid_recipe() IS
  'Posts trigger: a post whose recipe is paid stores no prompt (owner decision, 2026-10-31).';

-- UPDATE only: a recipe points at an existing post, so a post being inserted
-- has none. An upsert that finds the post runs this as an update.
--
-- One save that sends a prompt and removes the paid recipe stores no prompt:
-- the publish RPC writes the post before its recipe, so this trigger still
-- sees the recipe. Only the API can send a prompt; sent again, with the
-- recipe gone, it is stored.
--
-- Order. BEFORE triggers fire in name order. `b_` keeps
-- a_posts_store_unlisted_as_private first, as its own test requires, and puts
-- this one ahead of posts_advance_nsfw_revision, which then compares the
-- prompt this trigger leaves: a dropped write is no change and ends no
-- reveal.
CREATE OR REPLACE TRIGGER b_posts_keep_prompt_out_of_paid_recipe
BEFORE UPDATE OF prompt ON public.posts
FOR EACH ROW
WHEN (NEW.prompt IS NOT NULL)
EXECUTE FUNCTION public.keep_post_prompt_out_of_paid_recipe();

-- ─── 3. The posts that already break the rule ───────────────────────────────

-- A post whose owner has an account deletion job is left alone. The content
-- freeze (reject_post_write_during_account_deletion) refuses a direct write
-- to it, which would fail this migration and the release, and the deletion
-- removes the post anyway.
UPDATE public.posts AS posts
SET prompt = NULL
WHERE posts.prompt IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.post_resource_bundles AS bundles
    WHERE bundles.post_id = posts.id
      AND bundles.access_mode = 'paid'
  )
  AND NOT public.is_account_deletion_requested(posts.user_id);

COMMIT;

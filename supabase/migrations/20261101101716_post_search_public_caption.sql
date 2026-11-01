-- Post search holds a post's caption as public reads show it.
--
-- Under a published paid recipe, public reads show no caption that is the
-- saved generation setup the recipe sells: a body whose first line is "Saved
-- generation setup" (sanitizePublicPostContent and isGeneratedRecipeSetupText
-- in src/lib/post-public-content.ts). They see a post's recipe only while it
-- is published (get_public_post_resource_bundle_summaries): a draft sells
-- nothing, and its post shows its caption. refresh_post_search_documents put
-- the raw body into search_text and search_vector, and search_public_posts
-- matches on both, so a word of that caption still found the post, shown
-- with its caption blank.
--
-- 1. refresh_post_search_documents reads the body through
--    public.recipe_post_public_body (20261101072014, the app's rule in SQL),
--    given the access mode of the post's published recipe. The stored caption
--    is untouched (the owner's decision, 2026-11-01: "Search index only"), so
--    a recipe made free, taken back to draft or deleted lets it find the post
--    again.
-- 2. Its posts trigger follows only posts columns, so a recipe now
--    re-projects its post's document when it is added or deleted, and when
--    its post, access mode or status changes (both posts, when it moves).
-- 3. The documents of posts whose published recipe is paid are re-projected
--    at the end. Production on 2026-11-01 had no paid recipe on a setup
--    caption, so none of them changes there.
--
-- Only the FROM clause and the two reads of the body differ from the
-- 20260827110000_public_search.sql definition; its signature, eligibility,
-- weights, definer rights, search path and grants are kept.
-- src/__tests__/post-search-public-caption-migration.test.ts holds it to that.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes: the order the publish and edit routes take
-- (they lock the post, then write its recipe), so this cannot deadlock with
-- them. SHARE ROW EXCLUSIVE is what CREATE TRIGGER takes; reads go on beside
-- it. A post or recipe written while this file runs waits for it, and its
-- triggers then use the new projection. The triggers are made with CREATE OR
-- REPLACE, never DROP TRIGGER, whose ACCESS EXCLUSIVE lock would stop the
-- feed's reads of posts.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. The document holds the caption as public reads show it ──────────────

CREATE OR REPLACE FUNCTION public.refresh_post_search_documents(p_post_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_post_ids IS NULL OR cardinality(p_post_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM public.post_search_documents
  WHERE post_id = ANY (p_post_ids);

  INSERT INTO public.post_search_documents (
    post_id,
    creator_user_id,
    title_normalized,
    tool_normalized,
    search_text,
    search_vector,
    created_at
  )
  SELECT
    posts.id,
    posts.user_id,
    lower(btrim(coalesce(posts.title, ''))),
    lower(btrim(concat_ws(' ', posts.source_tool, posts.source_tool_slug))),
    lower(btrim(concat_ws(
      ' ',
      posts.title,
      public.recipe_post_public_body(posts.body, bundles.access_mode),
      posts.prompt,
      posts.source_tool,
      posts.source_tool_slug
    ))),
    setweight(to_tsvector('simple', coalesce(posts.title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(public.recipe_post_public_body(posts.body, bundles.access_mode), '')), 'B')
      || setweight(to_tsvector('simple', coalesce(posts.prompt, '')), 'B')
      || setweight(to_tsvector(
        'simple',
        concat_ws(' ', posts.source_tool, posts.source_tool_slug)
      ), 'C'),
    posts.created_at
  FROM public.posts AS posts
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.post_id = posts.id
    AND bundles.status = 'published'
  WHERE posts.id = ANY (p_post_ids)
    AND posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND posts.review_status = 'visible';
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_post_search_documents(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_search_documents(uuid[]) TO service_role;

-- ─── 2. A recipe change re-projects its post's document ─────────────────────

CREATE OR REPLACE FUNCTION public.trg_refresh_post_search_document_for_recipe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_post_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_post_ids := ARRAY[NEW.post_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_post_ids := ARRAY[OLD.post_id];
  ELSE
    v_post_ids := ARRAY[OLD.post_id, NEW.post_id];
  END IF;

  -- Lock the posts before projecting, as an edit of one does. An edit running
  -- at the same time then either waits for this recipe to commit and projects
  -- it, or commits first and this projects its caption. Without the lock, each
  -- could project the other's change as it was before, and the later write
  -- would leave that. The publish and edit routes hold the post already when
  -- they write its recipe, so for them this takes nothing new. A post deleted
  -- with its recipe is gone: nothing to lock or project.
  PERFORM 1
  FROM public.posts
  WHERE id = ANY (v_post_ids)
  ORDER BY id
  FOR NO KEY UPDATE;

  PERFORM public.refresh_post_search_documents(v_post_ids);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_refresh_post_search_document_for_recipe()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.trg_refresh_post_search_document_for_recipe() IS
  'Recipe trigger: re-projects the search document of the recipe''s post (both, when it moves), which reads the post''s caption as its published recipe shows it.';

CREATE OR REPLACE TRIGGER post_resource_bundles_refresh_post_search_insert_delete
AFTER INSERT OR DELETE ON public.post_resource_bundles
FOR EACH ROW
EXECUTE FUNCTION public.trg_refresh_post_search_document_for_recipe();

-- The columns the document reads; an edit of what the recipe sells, or a sale,
-- leaves the post's document alone.
CREATE OR REPLACE TRIGGER post_resource_bundles_refresh_post_search_update
AFTER UPDATE OF post_id, access_mode, status ON public.post_resource_bundles
FOR EACH ROW
WHEN (
  OLD.post_id IS DISTINCT FROM NEW.post_id
    OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
    OR OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.trg_refresh_post_search_document_for_recipe();

-- ─── 3. The documents the rule can change ───────────────────────────────────

SELECT public.refresh_post_search_documents(ARRAY(
  SELECT bundles.post_id
  FROM public.post_resource_bundles AS bundles
  WHERE bundles.access_mode = 'paid'
    AND bundles.status = 'published'
));

COMMIT;

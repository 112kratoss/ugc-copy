-- Marketplace search matches only what a visitor who has not unlocked a
-- recipe can see.
--
-- list_marketplace_resource_bundles matches a search against
-- marketplace_bundle_search_documents. Each document now holds exactly the
-- fields the app checks a listed recipe on (marketplaceItemMatchesQuery in
-- src/lib/post-resource-bundles-server.ts), in the order it joins them:
--   - the recipe's title, summary and preview;
--   - its seller's username and display name;
--   - its post's title, caption and tool;
--   - its kinds (prompt, workflow, files, notes, remix), as the recipe card
--     shows them.
-- It no longer holds the recipe's items (their titles, descriptions and
-- text) or its cards. Those are what an unlock gives: a locked recipe shows
-- their kinds and counts only (sanitizePostResourceBundleLockedPreview), free
-- or paid. The database and the app therefore match a search on the same
-- text, and the rows the list skips are only those it hides for other
-- reasons (a hidden post, the quality check).
--
-- Kinds, as getPostResourceKinds reads the stored recipe:
--   - a recipe with items takes them from its items' types alone;
--   - one without takes them from its legacy columns, a legacy attachment
--     counting as files. getPostResourceKinds can read some attachments as
--     another kind; no stored recipe takes this branch (the write path
--     stores items for every resource; production had none without items,
--     read-only count, 2026-10-31);
--   - either holds Remix when its stored switch is on, when an item is a
--     Remix, or when it is published on a post made from a creation
--     (resolveRecipeAllowRemix).
-- So the recipe trigger now follows every column the document reads and no
-- longer the recipe's cards, and the posts trigger follows the post's
-- creation as well.
--
-- Every stored document is re-projected at the end of the file: 17 in
-- production on 2026-10-31, each holding its items' text.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes: the order the publish and edit routes take
-- (they lock the post, then write its recipe), so this cannot deadlock with
-- them. SHARE ROW EXCLUSIVE is what CREATE TRIGGER takes; reads go on beside
-- it. A post or recipe written while this file runs waits for it, and its
-- triggers then use the new projection. The triggers are made with CREATE OR
-- REPLACE, never DROP TRIGGER, whose ACCESS EXCLUSIVE lock would stop the
-- feed's reads of posts.
--
-- profiles is not locked: its writers include the credit and purchase paths,
-- whose lock order against these tables is not one this file can follow. A
-- seller's rename that runs alongside this file can still write their
-- recipes' documents with the old projection; the next edit of the recipe,
-- its post or their name projects them again.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_search_documents(
  p_bundle_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  INSERT INTO public.marketplace_bundle_search_documents AS documents (bundle_id, search_text)
  SELECT
    bundles.id,
    lower(concat_ws(
      ' ',
      bundles.title,
      bundles.summary,
      bundles.preview_text,
      profiles.username,
      profiles.display_name,
      posts.title,
      posts.body,
      posts.source_tool,
      nullif(concat_ws(
        ' ',
        CASE WHEN kinds.prompt THEN 'prompt' END,
        CASE WHEN kinds.workflow THEN 'workflow' END,
        CASE WHEN kinds.files THEN 'files' END,
        CASE WHEN kinds.notes THEN 'notes' END,
        CASE WHEN kinds.remix THEN 'remix' END
      ), '')
    ))
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  CROSS JOIN LATERAL (
    -- The recipe's item types; NULL when it has no item of a known type.
    SELECT array_agg(DISTINCT item->>'type') AS types
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(bundles.resource_items) = 'array' THEN bundles.resource_items
        ELSE '[]'::jsonb
      END
    ) AS item
    WHERE item->>'type' IN (
      'prompt', 'workflow', 'reference_image', 'reference_video', 'reference_audio',
      'source_file', 'preset', 'settings', 'note', 'external_link', 'remix_link', 'remix_access'
    )
  ) AS items
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN items.types IS NOT NULL THEN 'prompt' = ANY (items.types)
        ELSE btrim(coalesce(bundles.prompt_text, '')) <> ''
      END AS prompt,
      CASE
        WHEN items.types IS NOT NULL THEN 'workflow' = ANY (items.types)
        ELSE btrim(coalesce(bundles.workflow_share_url, '')) <> ''
          OR coalesce(jsonb_typeof(bundles.workflow_snapshot), 'null') <> 'null'
      END AS workflow,
      CASE
        WHEN items.types IS NOT NULL THEN items.types && ARRAY[
          'reference_image', 'reference_video', 'reference_audio', 'source_file', 'preset', 'external_link'
        ]
        -- A legacy attachment counts as normalizePostResourceAttachments keeps
        -- it: a file with a path, or a link with a URL.
        ELSE EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(bundles.attachments) = 'array' THEN bundles.attachments
              ELSE '[]'::jsonb
            END
          ) AS attachment
          WHERE jsonb_typeof(attachment) = 'object'
            AND CASE
              WHEN attachment->>'kind' = 'file' THEN
                jsonb_typeof(attachment->'storagePath') = 'string'
                AND ltrim(btrim(attachment->>'storagePath'), '/') <> ''
              ELSE
                jsonb_typeof(attachment->'url') = 'string'
                AND btrim(attachment->>'url') <> ''
            END
        )
      END AS files,
      CASE
        WHEN items.types IS NOT NULL THEN items.types && ARRAY['note', 'settings']
        ELSE btrim(coalesce(bundles.notes_markdown, '')) <> ''
      END AS notes,
      bundles.allow_remix IS TRUE
        OR coalesce(items.types && ARRAY['remix_access', 'remix_link'], false)
        OR (bundles.status = 'published' AND posts.generation_id IS NOT NULL) AS remix
  ) AS kinds
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET search_text = excluded.search_text
  WHERE documents.search_text IS DISTINCT FROM excluded.search_text;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[]) IS
  'Projects a recipe''s marketplace search document from what a visitor who has not unlocked it sees: the fields marketplaceItemMatchesQuery reads, its kinds included. Never its items or cards. NULL projects every recipe.';

COMMENT ON TABLE public.marketplace_bundle_search_documents IS
  'Derived, trigger-maintained text searched by list_marketplace_resource_bundles: a recipe''s visible fields and kinds only. It avoids an O(catalog) concat/JSON expansion for every public search.';

-- Every recipe column the document reads.
CREATE OR REPLACE TRIGGER post_resource_bundles_refresh_marketplace_search_update
  AFTER UPDATE ON public.post_resource_bundles
  FOR EACH ROW
  WHEN (
    OLD.post_id IS DISTINCT FROM NEW.post_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.summary IS DISTINCT FROM NEW.summary
    OR OLD.preview_text IS DISTINCT FROM NEW.preview_text
    OR OLD.prompt_text IS DISTINCT FROM NEW.prompt_text
    OR OLD.notes_markdown IS DISTINCT FROM NEW.notes_markdown
    OR OLD.workflow_share_url IS DISTINCT FROM NEW.workflow_share_url
    OR OLD.workflow_snapshot IS DISTINCT FROM NEW.workflow_snapshot
    OR OLD.attachments IS DISTINCT FROM NEW.attachments
    OR OLD.resource_items IS DISTINCT FROM NEW.resource_items
    OR OLD.allow_remix IS DISTINCT FROM NEW.allow_remix
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();

-- Every post column the document reads: the creation decides Remix.
CREATE OR REPLACE TRIGGER posts_refresh_marketplace_search
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  WHEN (
    OLD.title IS DISTINCT FROM NEW.title
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_post();

-- Re-project every stored document. Only the documents whose text changes
-- are written.
SELECT public.refresh_marketplace_bundle_search_documents(NULL);

COMMIT;

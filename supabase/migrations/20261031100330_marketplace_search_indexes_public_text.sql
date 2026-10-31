-- Marketplace search matches only what a visitor who has not unlocked a
-- recipe can see.
--
-- list_marketplace_resource_bundles matches a search against
-- marketplace_bundle_search_documents. Each document now holds the text the
-- app checks a listed recipe on (marketplaceItemMatchesQuery in
-- src/lib/post-resource-bundles-server.ts), in the order it joins it:
--   - the recipe's title as its card shows it (normalizeBundleDisplayTitle:
--     'Recipe' for a blank or 'Attached unlock' title), its summary and its
--     preview;
--   - its seller's username and name (getCreatorDisplayName: the display
--     name, else the username);
--   - its post's title, caption and tool;
--   - its kinds (prompt, workflow, files, notes, remix), as
--     getPostResourceKinds reads the stored recipe.
-- An empty field is left out, as the app's check leaves it out.
--
-- It no longer holds the recipe's items (their titles, descriptions and
-- text) or its cards. Those are what an unlock gives: a locked recipe shows
-- their kinds and counts only (sanitizePostResourceBundleLockedPreview), free
-- or paid.
--
-- The list also read a query's % and _ as wildcards and \ as an escape, which
-- the app's check reads as plain characters. It now matches them literally,
-- as search_public_posts does.
--
-- The two still differ on a post with no title, which the app shows under its
-- caption's first line or 'Untitled creation'. A search across that title can
-- find the recipe in one and not the other; the text is the post's own
-- caption or a fixed label, never the recipe's contents.
--
-- Kinds, as getPostResourceKinds reads the stored recipe:
--   - from its items' types. The legacy columns are not read: the write path
--     stores items for every resource (production had no recipe without
--     items, read-only count, 2026-10-31), and getPostResourceKinds reads them
--     only for a recipe that has none;
--   - Remix when its stored switch is on, when an item is a Remix, or when it
--     is published on a post made from a creation (resolveRecipeAllowRemix,
--     as hydrateBundleRows calls it).
-- So the recipe trigger now follows its status and Remix switch and no longer
-- its cards, and the posts trigger follows the post's creation.
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
      CASE
        WHEN lower(btrim(coalesce(bundles.title, ''))) IN ('', 'attached unlock') THEN 'Recipe'
        ELSE btrim(bundles.title)
      END,
      nullif(bundles.summary, ''),
      nullif(bundles.preview_text, ''),
      nullif(profiles.username, ''),
      coalesce(nullif(btrim(profiles.display_name), ''), nullif(btrim(profiles.username), ''), 'Creator'),
      nullif(btrim(posts.title), ''),
      nullif(btrim(posts.body), ''),
      nullif(posts.source_tool, ''),
      nullif(concat_ws(
        ' ',
        CASE WHEN 'prompt' = ANY (items.types) THEN 'prompt' END,
        CASE WHEN 'workflow' = ANY (items.types) THEN 'workflow' END,
        CASE WHEN items.types && ARRAY[
          'reference_image', 'reference_video', 'reference_audio', 'source_file', 'preset', 'external_link'
        ] THEN 'files' END,
        CASE WHEN items.types && ARRAY['note', 'settings'] THEN 'notes' END,
        CASE
          WHEN bundles.allow_remix IS TRUE
            OR items.types && ARRAY['remix_access', 'remix_link']
            OR (bundles.status = 'published' AND posts.generation_id IS NOT NULL)
          THEN 'remix'
        END
      ), '')
    ))
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  CROSS JOIN LATERAL (
    -- The recipe's item types, trimmed as normalizePostResourceItems trims
    -- them; NULL when it has no item of a known type.
    SELECT array_agg(DISTINCT btrim(item->>'type')) AS types
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(bundles.resource_items) = 'array' THEN bundles.resource_items
        ELSE '[]'::jsonb
      END
    ) AS item
    WHERE btrim(item->>'type') IN (
      'prompt', 'workflow', 'reference_image', 'reference_video', 'reference_audio',
      'source_file', 'preset', 'settings', 'note', 'external_link', 'remix_link', 'remix_access'
    )
  ) AS items
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET search_text = excluded.search_text
  WHERE documents.search_text IS DISTINCT FROM excluded.search_text;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  TO service_role;

COMMENT ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[]) IS
  'Projects a recipe''s marketplace search document from what a visitor who has not unlocked it sees: the text marketplaceItemMatchesQuery reads, its kinds included. Never its items or cards. NULL projects every recipe.';

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

-- The listing (latest: 20261017145444_free_unlocks_are_not_sales.sql), as it
-- was but for its search pattern: the query's \, % and _ are escaped, as
-- search_public_posts escapes them, so they match themselves. The trigram
-- index still serves the pattern, and every ORDER BY is unchanged, so each
-- sort still matches its index. The filter reaches format() as an argument,
-- which format() leaves as it is: the pattern's two-percent ends are two
-- wildcards, as before, and each escape names a single %.
CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text DEFAULT 'all',
  p_resource_filter text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_sort text DEFAULT 'recent',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 24
)
RETURNS TABLE(
  id uuid, post_id uuid, owner_user_id uuid, legacy_asset_id uuid,
  access_mode text, status text, title text, summary text, preview_text text,
  prompt_text text, notes_markdown text, workflow_share_url text,
  workflow_snapshot jsonb, attachments jsonb, allow_remix boolean,
  resource_sections jsonb, resource_items jsonb, price_usd_cents integer,
  sales_count integer, free_unlock_count integer, earnings_usd_cents integer, created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order text;
  v_search_join text := '';
  v_search_filter text := 'AND coalesce(nullif(btrim($4), ''''), '''') = ''''';
BEGIN
  v_order := CASE coalesce(p_sort, 'recent')
    WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    ELSE 'listings.created_at DESC, listings.bundle_id DESC'
  END;

  IF coalesce(nullif(btrim(p_query), ''), '') <> '' THEN
    v_search_join := '
      JOIN public.marketplace_bundle_search_documents search
        ON search.bundle_id = listings.bundle_id';
    v_search_filter := '
      AND char_length(btrim($4)) >= 3
      AND search.search_text ILIKE (''%%'' || replace(replace(replace(lower(btrim($4)), ''\'', ''\\''), ''%'', ''\%''), ''_'', ''\_'') || ''%%'')';
  END IF;

  RETURN QUERY EXECUTE format($sql$
    SELECT
      bundles.id, bundles.post_id, bundles.owner_user_id, bundles.legacy_asset_id,
      bundles.access_mode, bundles.status, bundles.title, bundles.summary,
      bundles.preview_text, bundles.prompt_text, bundles.notes_markdown,
      bundles.workflow_share_url, bundles.workflow_snapshot, bundles.attachments,
      bundles.allow_remix, bundles.resource_sections, bundles.resource_items,
      bundles.price_usd_cents, bundles.sales_count, bundles.free_unlock_count, bundles.earnings_usd_cents,
      bundles.created_at, bundles.updated_at
    FROM public.marketplace_bundle_listings listings
    JOIN public.post_resource_bundles bundles ON bundles.id = listings.bundle_id
    %s
    WHERE listings.listable
      AND ($1 IS NULL OR $1 = 'all' OR listings.access_mode = $1)
      AND (
        $2 IS NULL OR $2 = 'all'
        OR ($2 = 'prompt' AND listings.has_prompt)
        OR ($2 = 'workflow' AND listings.has_workflow)
        OR ($2 = 'files' AND listings.has_files)
        OR ($2 = 'notes' AND listings.has_notes)
        OR ($2 = 'remix' AND listings.has_remix)
      )
      AND (coalesce(nullif($3, ''), '') = '' OR listings.tool_slug = $3)
      %s
    ORDER BY %s
    OFFSET greatest(coalesce($5, 0), 0)
    LIMIT greatest(coalesce($6, 24), 1)
  $sql$, v_search_join, v_search_filter, v_order)
  USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) IS
  'Marketplace listing backed by page-sized sort indexes and a trigger-maintained trigram search document. Public callers must require at least three search characters; the query''s characters match themselves.';

-- Re-project every stored document. Only the documents whose text changes
-- are written.
SELECT public.refresh_marketplace_bundle_search_documents(NULL);

COMMIT;

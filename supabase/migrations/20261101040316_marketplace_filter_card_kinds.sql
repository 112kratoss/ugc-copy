-- The marketplace's resource filter lists a recipe under the kinds its card
-- reads from what the recipe stores.
--
-- list_marketplace_resource_bundles filters ?resource=prompt|workflow|files|
-- notes|remix on marketplace_bundle_listings.has_*. Those flags were
-- projected from the recipe's legacy columns (prompt_text, notes_markdown,
-- workflow_share_url, workflow_snapshot, attachments) as well as its items,
-- with Remix only for the stored switch or a Remix item. The card reads its
-- kinds with getPostResourceKinds, as hydrateBundleRows calls it
-- (src/lib/post-resource-bundles-server.ts):
--   - from the types of its valid items (a known type, trimmed). The legacy
--     columns are read only for a recipe with no valid item, which the write
--     path never stores: it stores items, with trimmed types, for every
--     resource, and production had no recipe without one (2026-11-01). This
--     rule reads items alone and trims spaces alone, so only a row written
--     around the app (no valid item, or a type padded with a tab) differs;
--   - Remix when its stored switch is on, when an item is a Remix, or when it
--     is published on a post made from a creation (resolveRecipeAllowRemix).
-- A tile can also show Files that an unlock adds from a creation's shared
-- inputs: counted after the list, for the page it serves, on a recipe whose
-- stored switch is on. They are not stored, so no filter lists a recipe for
-- them, as before this file and as the app's own fallback filters (at most 4
-- listed recipes in production on 2026-11-01).
-- The marketplace serves what the list returns without checking the kind
-- again. In production on 2026-11-01 (read-only count: 17 recipes, every one
-- with items, 12 listed), the workflow filter listed 10 recipes whose cards
-- show no workflow, each for a workflow_snapshot stored as JSON null (IS NOT
-- NULL reads it as a workflow; the app reads it as none), and the Remix
-- filter left out 1 creation recipe whose card shows Remix.
--
-- The rule is now one function, public.post_resource_bundle_kinds, and both
-- marketplace projections call it: the listing's flags, and the search
-- document's kind words. It holds the search document's expression
-- (20261031100330_marketplace_search_indexes_public_text.sql) unchanged, so
-- no document's text changes. get_owner_post_bundle_summaries (the owner's
-- post lists, 20261017145444) keeps its own copy of the older rule, which
-- differs only on rows the write path never stores; it is not changed here.
--
-- The listing's posts trigger now follows the post's creation, which decides
-- Remix. Its recipe trigger already follows the status, items and switch, and
-- keeps the legacy columns: the listing gate's quality check still reads them.
--
-- Every listing row and search document is re-projected at the end of the
-- file; only those whose values change are written: 13 of the 17 listing
-- rows in production on 2026-11-01, and no document.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes, as 20261031100330 takes them: the order the
-- publish and edit routes lock in. No order avoids every writer: a paid
-- recipe's save writes the recipe, then the post (its clear-prompt trigger,
-- 20261031055009), and a post's exposure change writes its recipes. Against
-- those, the lock timeout or a deadlock aborts this whole file, one
-- transaction with nothing applied, and the release step is run again. A post
-- or recipe written while this file runs waits for it, and its triggers then
-- use the new projections. profiles is not locked, for the reason that file
-- gives: a seller's rename that runs alongside this file can still project
-- their recipes with the old rule, until the next edit of the recipe, its
-- post or their name.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;

-- A recipe's kinds as its card reads them from what it stores, in the app's
-- order (POST_RESOURCE_KIND_ORDER): getPostResourceKinds on its items'
-- types, with Remix as resolveRecipeAllowRemix resolves it for
-- hydrateBundleRows. Takes the recipe's post's generation_id; NULL for a post
-- without a creation. Not read: the legacy columns of a recipe with no valid
-- item, and the Files an unlock adds from a creation's shared inputs (header).
CREATE OR REPLACE FUNCTION public.post_resource_bundle_kinds(
  p_resource_items jsonb,
  p_allow_remix boolean,
  p_status text,
  p_post_generation_id uuid
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT array_remove(ARRAY[
    CASE WHEN 'prompt' = ANY (items.types) THEN 'prompt' END,
    CASE WHEN 'workflow' = ANY (items.types) THEN 'workflow' END,
    CASE WHEN items.types && ARRAY[
      'reference_image', 'reference_video', 'reference_audio', 'source_file', 'preset', 'external_link'
    ] THEN 'files' END,
    CASE WHEN items.types && ARRAY['note', 'settings'] THEN 'notes' END,
    CASE
      WHEN p_allow_remix IS TRUE
        OR items.types && ARRAY['remix_access', 'remix_link']
        OR (p_status = 'published' AND p_post_generation_id IS NOT NULL)
      THEN 'remix'
    END
  ], NULL)
  FROM (
    -- The recipe's item types, trimmed as normalizePostResourceItems trims
    -- them; NULL when it has no item of a known type.
    SELECT array_agg(DISTINCT btrim(item->>'type')) AS types
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_resource_items) = 'array' THEN p_resource_items
        ELSE '[]'::jsonb
      END
    ) AS item
    WHERE btrim(item->>'type') IN (
      'prompt', 'workflow', 'reference_image', 'reference_video', 'reference_audio',
      'source_file', 'preset', 'settings', 'note', 'external_link', 'remix_link', 'remix_access'
    )
  ) AS items
$function$;

REVOKE ALL ON FUNCTION public.post_resource_bundle_kinds(jsonb, boolean, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_resource_bundle_kinds(jsonb, boolean, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.post_resource_bundle_kinds(jsonb, boolean, text, uuid) IS
  'A recipe''s kinds as its card reads them from its stored items (getPostResourceKinds, with Remix as resolveRecipeAllowRemix resolves it), in the app''s order. Not the legacy columns of a recipe with no valid item, nor Files an unlock adds from a creation''s shared inputs. The one rule the marketplace listing''s filter flags and its search document read.';

-- The search document (latest: 20261031100330), as it was but for its kinds,
-- which the function above now holds.
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
      nullif(array_to_string(public.post_resource_bundle_kinds(
        bundles.resource_items, bundles.allow_remix, bundles.status, posts.generation_id
      ), ' '), '')
    ))
  FROM public.post_resource_bundles AS bundles
  LEFT JOIN public.posts AS posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles AS profiles ON profiles.id = bundles.owner_user_id
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET search_text = excluded.search_text
  WHERE documents.search_text IS DISTINCT FROM excluded.search_text;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_search_documents(uuid[])
  TO service_role;

-- The listing (latest: 20260809210000_marketplace_bundle_listings.sql), as it
-- was but for its five filter flags, which now read the function above.
CREATE OR REPLACE FUNCTION public.refresh_marketplace_bundle_listings(
  p_bundle_ids uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.marketplace_bundle_listings AS listings (
    bundle_id, listable, created_at, sales_count, price_usd_cents,
    access_mode, tool_slug, has_prompt, has_workflow, has_files, has_notes, has_remix
  )
  SELECT
    bundles.id,
    (
      posts.id IS NOT NULL
      AND bundles.status = 'published'
      AND posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND coalesce(posts.review_status, 'visible') <> 'hidden'
      AND public.marketplace_resource_bundle_quality_issue(
        bundles.title,
        bundles.summary,
        bundles.preview_text,
        bundles.prompt_text,
        bundles.notes_markdown,
        bundles.workflow_share_url,
        bundles.workflow_snapshot,
        (
          CASE
            WHEN jsonb_typeof(coalesce(bundles.attachments, '[]'::jsonb)) = 'array' THEN coalesce(bundles.attachments, '[]'::jsonb)
            ELSE '[]'::jsonb
          END
          || coalesce(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'label',
                  coalesce(
                    nullif(btrim(item->>'title'), ''),
                    nullif(btrim(item->>'description'), ''),
                    CASE coalesce(item->>'type', '')
                      WHEN 'prompt' THEN 'Prompt resource'
                      WHEN 'workflow' THEN 'Workflow resource'
                      WHEN 'reference_image' THEN 'Reference image'
                      WHEN 'reference_video' THEN 'Reference video'
                      WHEN 'reference_audio' THEN 'Reference audio'
                      WHEN 'source_file' THEN 'Source file'
                      WHEN 'preset' THEN 'Preset resource'
                      WHEN 'settings' THEN 'Settings resource'
                      WHEN 'note' THEN 'Note resource'
                      WHEN 'external_link' THEN 'External resource'
                      WHEN 'remix_access' THEN 'Remix access'
                      WHEN 'remix_link' THEN 'Remix link'
                      ELSE 'Resource item'
                    END
                  )
                )
              )
              FROM jsonb_array_elements(coalesce(bundles.resource_items, '[]'::jsonb)) AS item
            ),
            '[]'::jsonb
          )
        ),
        bundles.allow_remix,
        bundles.price_usd_cents,
        bundles.access_mode,
        posts.title,
        posts.body,
        posts.visibility,
        posts.archived_at,
        posts.review_status,
        (nullif(btrim(coalesce(posts.showcase_asset_path, '')), '') IS NOT NULL OR nullif(btrim(coalesce(posts.output_url, '')), '') IS NOT NULL),
        profiles.username,
        profiles.display_name
      ) IS NULL
    ),
    bundles.created_at,
    bundles.sales_count,
    bundles.price_usd_cents,
    bundles.access_mode,
    coalesce(
      nullif(posts.source_tool_slug, ''),
      lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
    ),
    -- The five filter flags: the kinds the recipe's card shows.
    'prompt' = ANY (resource.kinds),
    'workflow' = ANY (resource.kinds),
    'files' = ANY (resource.kinds),
    'notes' = ANY (resource.kinds),
    'remix' = ANY (resource.kinds)
  FROM public.post_resource_bundles bundles
  LEFT JOIN public.posts posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id
  CROSS JOIN LATERAL public.post_resource_bundle_kinds(
    bundles.resource_items, bundles.allow_remix, bundles.status, posts.generation_id
  ) AS resource(kinds)
  WHERE p_bundle_ids IS NULL OR bundles.id = ANY (p_bundle_ids)
  ON CONFLICT (bundle_id) DO UPDATE SET
    listable = excluded.listable,
    created_at = excluded.created_at,
    sales_count = excluded.sales_count,
    price_usd_cents = excluded.price_usd_cents,
    access_mode = excluded.access_mode,
    tool_slug = excluded.tool_slug,
    has_prompt = excluded.has_prompt,
    has_workflow = excluded.has_workflow,
    has_files = excluded.has_files,
    has_notes = excluded.has_notes,
    has_remix = excluded.has_remix
  -- Assigns, never accumulates, and skips no-op writes so a re-run is free.
  WHERE listings.* IS DISTINCT FROM excluded.*;
$function$;

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[])
  TO service_role;

-- Every post column the listing reads: the three moderation gates, the two
-- quality-text inputs, the two media inputs, the two tool-slug inputs, and
-- the creation, which decides Remix. The hot counters stay out, as
-- 20260809210000 explains.
CREATE OR REPLACE TRIGGER posts_refresh_marketplace_listing
  AFTER UPDATE ON public.posts
  FOR EACH ROW
  WHEN (
    OLD.visibility IS DISTINCT FROM NEW.visibility
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.review_status IS DISTINCT FROM NEW.review_status
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.showcase_asset_path IS DISTINCT FROM NEW.showcase_asset_path
    OR OLD.output_url IS DISTINCT FROM NEW.output_url
    OR OLD.source_tool_slug IS DISTINCT FROM NEW.source_tool_slug
    OR OLD.source_tool IS DISTINCT FROM NEW.source_tool
    OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();

-- Re-project every search document and listing row. Only those whose values
-- change are written.
SELECT public.refresh_marketplace_bundle_search_documents(NULL);
SELECT public.refresh_marketplace_bundle_listings(NULL);

COMMIT;

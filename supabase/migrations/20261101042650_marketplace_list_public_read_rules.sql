-- The marketplace list and its search apply two rules the feed, the post page
-- and post search already apply.
--
-- 1. A paid recipe's post shows no caption that is the saved generation setup
--    the recipe sells: a body whose first line is "Saved generation setup"
--    (sanitizePublicPostContent and isGeneratedRecipeSetupText in
--    src/lib/post-public-content.ts). The app now reads every recipe's post
--    that way (loadLinkedPostMap in src/lib/post-resource-bundles-server.ts),
--    for the card, the search check and the quality check. Here:
--      - public.recipe_post_public_body is that rule, its one copy in the
--        database;
--      - the search document holds the post's caption only as the card shows
--        it, so the recipe trigger now follows access_mode;
--      - the listing's quality gate judges the post's public proof on that
--        caption, as the app's check does. A paid recipe whose post shows
--        nothing but its setup is not listed, and its seller's dashboard says
--        why. The listing trigger already follows access_mode and the post's
--        body.
-- 2. A recipe on an NSFW-labelled post is not listable. The list is the same
--    for every viewer, and the app left these recipes out only after the list
--    function had paged them, so a page could hold rows nobody was shown.
--    search_public_posts leaves NSFW posts out before its limit the same way.
--    The listing's posts trigger follows is_nsfw, so a label takes the recipe
--    off the list in the transaction that sets it, and removing the label
--    lists it again. The recipe itself is untouched: its creator and its
--    buyers read it on their own pages, behind the owner, reveal and purchase
--    checks.
--
-- Each function is re-created as it was but for the lines above:
-- refresh_marketplace_bundle_listings as 20260809210000 made it, and
-- refresh_marketplace_bundle_search_documents as 20261031100330 made it.
-- src/__tests__/marketplace-list-public-read-rules-migration.test.ts holds each
-- to that, and the rule to the app's.
--
-- Every listing and document is re-projected at the end. Production on
-- 2026-11-01 (read-only counts): 17 recipes, 12 listed; one post with a setup
-- caption, under a free recipe; no NSFW-labelled post. Neither rule changes a
-- row there.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes: the order the publish and edit routes take
-- (they lock the post, then write its recipe), so this cannot deadlock with
-- them. SHARE ROW EXCLUSIVE is what CREATE TRIGGER takes; reads go on beside
-- it. A post or recipe written while this file runs waits for it, and its
-- triggers then use the new projections. The triggers are made with CREATE OR
-- REPLACE, never DROP TRIGGER, whose ACCESS EXCLUSIVE lock would stop the
-- feed's reads of posts.
--
-- profiles is not locked, as in 20261031100330: a seller's rename that runs
-- alongside this file can still write their recipes' rows with the old
-- projections; the next edit of the recipe, its post or their name projects
-- them again.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;

-- ─── The rule ────────────────────────────────────────────────────────────────
--
-- sanitizePublicPostContent's body: under a paid recipe, a body whose first
-- line is the heading shows as nothing. isGeneratedRecipeSetupText takes the
-- text with \r\n read as \n and both ends trimmed, cuts it at its first \n,
-- and trims and lower-cases that line. It trims what String.prototype.trim
-- removes: JavaScript's white space and line terminators, not only spaces. A
-- lone \r or a line separator inside the line does not end it, as
-- split('\n') does not.
CREATE OR REPLACE FUNCTION public.recipe_post_public_body(p_body text, p_access_mode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_access_mode = 'paid'
      AND lower(btrim(split_part(btrim(replace(p_body, E'\r\n', E'\n'), trim_set.chars), E'\n', 1), trim_set.chars))
        = 'saved generation setup'
    THEN NULL
    ELSE p_body
  END
  FROM (
    SELECT E' \t\n\u000b\f\r                 　﻿'::text AS chars
  ) AS trim_set;
$function$;

REVOKE ALL ON FUNCTION public.recipe_post_public_body(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recipe_post_public_body(text, text)
  TO service_role;

COMMENT ON FUNCTION public.recipe_post_public_body(text, text) IS
  'A recipe''s post body as public reads show it (sanitizePublicPostContent): NULL under a paid recipe when its first line is "Saved generation setup", else the body.';

-- ─── The search document ─────────────────────────────────────────────────────
--
-- As 20261031100330 made it, but for the post's caption, held as the card
-- shows it.
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
      nullif(btrim(public.recipe_post_public_body(posts.body, bundles.access_mode)), ''),
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

-- Every recipe column the document reads: access_mode decides the caption.
CREATE OR REPLACE TRIGGER post_resource_bundles_refresh_marketplace_search_update
  AFTER UPDATE ON public.post_resource_bundles
  FOR EACH ROW
  WHEN (
    OLD.post_id IS DISTINCT FROM NEW.post_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.summary IS DISTINCT FROM NEW.summary
    OR OLD.preview_text IS DISTINCT FROM NEW.preview_text
    OR OLD.resource_items IS DISTINCT FROM NEW.resource_items
    OR OLD.allow_remix IS DISTINCT FROM NEW.allow_remix
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_search_for_bundle();

-- ─── The listing ─────────────────────────────────────────────────────────────
--
-- As 20260809210000 made it, but for two lines of `listable`: a recipe on an
-- NSFW-labelled post is not listable, and the quality gate reads the post's
-- caption as public reads show it.
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
      AND posts.is_nsfw = false
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
        public.recipe_post_public_body(posts.body, bundles.access_mode),
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
    -- The five resource-kind predicates, byte-for-byte as the list function
    -- evaluated them per row. Precomputing them is the second half of the
    -- catalog-scale win: five jsonb containment checks per candidate row become
    -- five booleans read from a narrow index.
    (
      nullif(btrim(coalesce(bundles.prompt_text, '')), '') IS NOT NULL
      OR bundles.resource_items @> '[{"type":"prompt"}]'::jsonb
    ),
    (
      nullif(btrim(coalesce(bundles.workflow_share_url, '')), '') IS NOT NULL
      OR bundles.workflow_snapshot IS NOT NULL
      OR bundles.resource_items @> '[{"type":"workflow"}]'::jsonb
    ),
    (
      (jsonb_typeof(bundles.attachments) = 'array' AND jsonb_array_length(bundles.attachments) > 0)
      OR bundles.resource_items @> '[{"type":"reference_image"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"reference_video"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"reference_audio"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"source_file"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"preset"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"external_link"}]'::jsonb
    ),
    (
      nullif(btrim(coalesce(bundles.notes_markdown, '')), '') IS NOT NULL
      OR bundles.resource_items @> '[{"type":"note"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"settings"}]'::jsonb
    ),
    (
      bundles.allow_remix = true
      OR bundles.resource_items @> '[{"type":"remix_access"}]'::jsonb
      OR bundles.resource_items @> '[{"type":"remix_link"}]'::jsonb
    )
  FROM public.post_resource_bundles bundles
  LEFT JOIN public.posts posts ON posts.id = bundles.post_id
  LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id
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

-- Every post column the listing reads, is_nsfw now among them. Hot counters
-- stay out (see 20260809210000).
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
    OR OLD.is_nsfw IS DISTINCT FROM NEW.is_nsfw
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();

-- Re-project every listing and document. Only the rows whose values change are
-- written.
SELECT public.refresh_marketplace_bundle_listings(NULL);
SELECT public.refresh_marketplace_bundle_search_documents(NULL);

COMMIT;

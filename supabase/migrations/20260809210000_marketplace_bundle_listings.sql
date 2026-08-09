-- F5b: make the marketplace listing's execution cost scale with page size
-- rather than catalog size.
--
-- READ THE MEASUREMENT FIRST. F5b's original diagnosis was overturned on
-- 2026-08-09: production's ~930 blocks/call is planning plus a ~200-block
-- PostgREST floor, NOT the query -- execution is 34 buffers at 9 published
-- bundles. So this migration is explicitly NOT a fix for today's number, and
-- `shared_blks_hit / calls` will barely move after it. It fixes the growth
-- curve. Today's 34 buffers are ~3.8 per bundle because the listing:
--
--   1. evaluates `marketplace_resource_bundle_quality_issue` -- plpgsql, so
--      never inlined -- once per candidate row before ORDER BY ... LIMIT;
--   2. evaluates five jsonb containment predicates per row for the resource
--      filter; and
--   3. orders by `CASE WHEN p_sort = ...`, which cannot match any index, so
--      every page sorts the whole filtered catalog.
--
-- All three are O(catalog). This migration precomputes (1) and (2) and gives
-- (3) a real index per sort.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SEPARATE TABLE, AND NOT A COLUMN ON post_resource_bundles
--
-- The obvious shape is a `marketplace_listable` column on the bundle. It was
-- built that way first and it is wrong, for a reason worth recording because it
-- is invisible until you run it: `post_resource_bundles` carries SIX
-- BEFORE/AFTER triggers written for user edits, and a derived-column write goes
-- through all of them.
--
-- `validate_post_resource_bundle_write()` raises "Only public posts can publish
-- resource bundles" whenever `status = 'published'` and the post is not public.
-- So a moderator hiding a post would fire the recompute, the recompute would
-- write the bundle, and the write would RAISE -- meaning the take-down itself
-- fails. Not a stale listing: a moderation action that errors. Seeding this
-- migration's own test catalog is what surfaced it.
--
-- The others are no better: `capture_post_resource_bundle_revision()` would
-- write a revision row every time a gate flipped, `touch_updated_at_column()`
-- would bump a user-visible `updated_at`, and
-- `protect_sold_post_resource_bundle_content()` guards sold bundles against
-- exactly this kind of write. The existing `sync_sold_post_resource_bundle_
-- visibility()` only gets away with writing bundles from a posts trigger
-- because it sets `status = 'draft'`, which makes the validation pass.
--
-- Suppressing six triggers -- two of which are money and moderation controls --
-- to make room for a cache column is a far larger blast radius than the item
-- warrants. A derived table nobody else writes to has none of that surface, and
-- it lets the listing carry its sort keys and filter flags too, so filter and
-- sort become a single narrow index scan with the wide bundle row fetched by
-- primary key for the page only.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THIS IS A MODERATION CONTROL, NOT ONLY A PERFORMANCE CHANGE. Before this
-- migration, post visibility reached the listing through a live join on
-- `posts`, so a take-down was reflected the instant it committed. Now it leaves
-- the listing only if the `posts` trigger fires. A missed trigger column is
-- therefore taken-down content staying listed -- strictly worse than the
-- `SHOWCASE_FEED_CACHE_TAG` over-invalidation F5b already found and left alone.
-- The WHEN clause below is an explicit column list rather than
-- `OLD.* IS DISTINCT FROM NEW.*` ONLY because `posts` carries hot counters
-- (`save_count`, `comment_count`, `share_count`, `report_count`), and
-- recomputing a quality predicate on every comment would put this on a hot
-- write path. `marketplace_bundle_listings.test.sql` asserts the take-down path
-- directly, and the migration test asserts the column list still covers every
-- post column the predicate reads.
--
-- The audit predicted triggers on two tables. It is three -- the quality
-- predicate also takes `p_seller_username` and `p_seller_display_name` from
-- `profiles`, so an incomplete creator profile is a listing gate too.

CREATE TABLE IF NOT EXISTS public.marketplace_bundle_listings (
  bundle_id uuid PRIMARY KEY REFERENCES public.post_resource_bundles(id) ON DELETE CASCADE,
  -- The whole listing predicate: bundle status, the three post-visibility
  -- gates, and the quality predicate, collapsed to one indexable boolean.
  listable boolean NOT NULL DEFAULT false,
  -- Sort keys, copied so ordering never touches the wide bundle row.
  created_at timestamptz,
  sales_count integer,
  price_usd_cents integer,
  -- Filter keys.
  access_mode text,
  tool_slug text,
  has_prompt boolean NOT NULL DEFAULT false,
  has_workflow boolean NOT NULL DEFAULT false,
  has_files boolean NOT NULL DEFAULT false,
  has_notes boolean NOT NULL DEFAULT false,
  has_remix boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.marketplace_bundle_listings IS
  'F5b: derived index of the marketplace listing -- one row per bundle carrying the precomputed listing gate, sort keys and filter flags. Maintained only by refresh_marketplace_bundle_listings() via triggers on post_resource_bundles, posts and profiles. Never written by application code.';

COMMENT ON COLUMN public.marketplace_bundle_listings.listable IS
  'Bundle status + post visibility/archive/review + marketplace_resource_bundle_quality_issue() IS NULL. This is a moderation gate: if it goes stale, taken-down content stays listed.';

REVOKE ALL ON public.marketplace_bundle_listings FROM PUBLIC;
REVOKE ALL ON public.marketplace_bundle_listings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketplace_bundle_listings TO service_role;

ALTER TABLE public.marketplace_bundle_listings ENABLE ROW LEVEL SECURITY;

-- ─── The single definition of "listable" ─────────────────────────────────────
--
-- This expression exists exactly once, here. The list function no longer
-- carries a copy, so the two cannot drift.

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

COMMENT ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) IS
  'F5b: recompute the derived marketplace listing index. NULL recomputes every bundle (used by the backfill, and safe to re-run at any time to repair drift).';

REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_marketplace_bundle_listings(uuid[]) TO service_role;

-- ─── Triggers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_listing_for_bundle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_listings(ARRAY[NEW.id]);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_listing_for_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_listings(
    array(SELECT id FROM public.post_resource_bundles WHERE post_id = NEW.id)
  );
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_refresh_marketplace_listing_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.refresh_marketplace_bundle_listings(
    array(SELECT id FROM public.post_resource_bundles WHERE owner_user_id = NEW.id)
  );
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS post_resource_bundles_refresh_marketplace_listing_insert ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_refresh_marketplace_listing_insert
  AFTER INSERT ON public.post_resource_bundles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_bundle();

-- Every bundle column that feeds the gate, a sort key, or a filter flag.
-- `sales_count` is included because it is a sort key, which means a purchase
-- re-evaluates the quality predicate for that one bundle. That is one plpgsql
-- call on a money path that already writes several rows -- deliberate, and
-- cheaper than letting `top-sales` order by a stale count.
DROP TRIGGER IF EXISTS post_resource_bundles_refresh_marketplace_listing_update ON public.post_resource_bundles;
CREATE TRIGGER post_resource_bundles_refresh_marketplace_listing_update
  AFTER UPDATE ON public.post_resource_bundles
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.post_id IS DISTINCT FROM NEW.post_id
    OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
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
    OR OLD.price_usd_cents IS DISTINCT FROM NEW.price_usd_cents
    OR OLD.sales_count IS DISTINCT FROM NEW.sales_count
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_bundle();

-- Every post column the listing reads: the three moderation gates, the two
-- quality-text inputs, the two media inputs, and the two tool-slug inputs.
-- Hot counters are excluded on purpose -- see the header.
DROP TRIGGER IF EXISTS posts_refresh_marketplace_listing ON public.posts;
CREATE TRIGGER posts_refresh_marketplace_listing
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
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_post();

-- `profiles.credits` changes on every generation, so this must never be an
-- unconditional row trigger.
DROP TRIGGER IF EXISTS profiles_refresh_marketplace_listing ON public.profiles;
CREATE TRIGGER profiles_refresh_marketplace_listing
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  WHEN (
    OLD.username IS DISTINCT FROM NEW.username
    OR OLD.display_name IS DISTINCT FROM NEW.display_name
  )
  EXECUTE FUNCTION public.trg_refresh_marketplace_listing_for_profile();

-- ─── Backfill ────────────────────────────────────────────────────────────────

SELECT public.refresh_marketplace_bundle_listings(NULL);

-- ─── Indexes: one per sort, so the index supplies the ordering ───────────────
--
-- Each ORDER BY in the listing function is byte-identical to one of these,
-- NULLS clauses included -- a mismatched NULLS direction silently costs the
-- index and reintroduces a full sort, which is exactly the regression this item
-- is about. `created_at DESC, bundle_id DESC` is the tiebreak everywhere,
-- matching the previous function's trailing sort keys.

CREATE INDEX IF NOT EXISTS marketplace_bundle_listings_recent_idx
  ON public.marketplace_bundle_listings (created_at DESC, bundle_id DESC)
  WHERE listable;

CREATE INDEX IF NOT EXISTS marketplace_bundle_listings_sales_idx
  ON public.marketplace_bundle_listings (sales_count DESC NULLS LAST, created_at DESC, bundle_id DESC)
  WHERE listable;

CREATE INDEX IF NOT EXISTS marketplace_bundle_listings_price_asc_idx
  ON public.marketplace_bundle_listings (price_usd_cents ASC NULLS LAST, created_at DESC, bundle_id DESC)
  WHERE listable;

CREATE INDEX IF NOT EXISTS marketplace_bundle_listings_price_desc_idx
  ON public.marketplace_bundle_listings (price_usd_cents DESC NULLS LAST, created_at DESC, bundle_id DESC)
  WHERE listable;

-- ─── The listing function ────────────────────────────────────────────────────
--
-- Dynamic SQL, and the reason is drift rather than cleverness. Each sort needs
-- a literal ORDER BY to match its index, but the WHERE block is a moderation
-- filter -- four hand-maintained copies of it is precisely how a gate ends up
-- applied in three branches and forgotten in the fourth. The ORDER BY fragment
-- is chosen by CASE from four hard-coded literals; no caller-supplied text ever
-- reaches the statement, and every value is bound through USING.

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
  id uuid,
  post_id uuid,
  owner_user_id uuid,
  legacy_asset_id uuid,
  access_mode text,
  status text,
  title text,
  summary text,
  preview_text text,
  prompt_text text,
  notes_markdown text,
  workflow_share_url text,
  workflow_snapshot jsonb,
  attachments jsonb,
  allow_remix boolean,
  resource_sections jsonb,
  resource_items jsonb,
  price_usd_cents integer,
  sales_count integer,
  earnings_usd_cents integer,
  created_at timestamptz,
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
  -- Not empty: $4 has to stay referenced in both branches or Postgres cannot
  -- infer its type and EXECUTE fails with "could not determine data type of
  -- parameter $4". In the no-search branch this is a tautology by
  -- construction -- we only take it when the query is blank.
  v_search_filter text := 'AND coalesce(nullif(btrim($4), ''''), '''') = ''''';
BEGIN
  v_order := CASE coalesce(p_sort, 'recent')
    WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
    ELSE 'listings.created_at DESC, listings.bundle_id DESC'
  END;

  -- Search joins posts and profiles; the default path does not join them at
  -- all. Composing the join in rather than always carrying it is the point:
  -- every cached page is a default page, and those now plan and execute
  -- against two tables instead of four.
  --
  -- Measured, because the first attempt got this wrong. Expressing search as a
  -- correlated EXISTS kept one query shape but ran the subquery per candidate
  -- row, and search REGRESSED from 89,390 buffers to 136,937 at a 20,000-bundle
  -- catalog. A plain join lets the planner hash it once. Search is still a
  -- substring match no btree can serve -- it scans, and it is meant to -- but
  -- it must not scan worse than before.
  IF coalesce(nullif(btrim(p_query), ''), '') <> '' THEN
    v_search_join := '
      JOIN public.posts posts ON posts.id = bundles.post_id
      LEFT JOIN public.profiles profiles ON profiles.id = bundles.owner_user_id';
    v_search_filter := '
      AND concat_ws(
        '' '',
        bundles.title,
        bundles.summary,
        bundles.preview_text,
        profiles.username,
        profiles.display_name,
        posts.title,
        posts.body,
        posts.source_tool,
        (
          SELECT string_agg(concat_ws('' '', item->>''title'', item->>''description'', item->>''textContent''), '' '')
          FROM jsonb_array_elements(coalesce(bundles.resource_items, ''[]''::jsonb)) AS item
        ),
        (
          SELECT string_agg(concat_ws('' '', section->>''title'', section->>''description'', section->>''kind''), '' '')
          FROM jsonb_array_elements(coalesce(bundles.resource_sections, ''[]''::jsonb)) AS section
        )
      ) ILIKE (''%%'' || btrim($4) || ''%%'')';
  END IF;

  RETURN QUERY EXECUTE format($sql$
    SELECT
      bundles.id,
      bundles.post_id,
      bundles.owner_user_id,
      bundles.legacy_asset_id,
      bundles.access_mode,
      bundles.status,
      bundles.title,
      bundles.summary,
      bundles.preview_text,
      bundles.prompt_text,
      bundles.notes_markdown,
      bundles.workflow_share_url,
      bundles.workflow_snapshot,
      bundles.attachments,
      bundles.allow_remix,
      bundles.resource_sections,
      bundles.resource_items,
      bundles.price_usd_cents,
      bundles.sales_count,
      bundles.earnings_usd_cents,
      bundles.created_at,
      bundles.updated_at
    FROM public.marketplace_bundle_listings listings
    JOIN public.post_resource_bundles bundles ON bundles.id = listings.bundle_id
    %s
    WHERE listings.listable
      AND ($1 IS NULL OR $1 = 'all' OR listings.access_mode = $1)
      AND (
        $2 IS NULL
        OR $2 = 'all'
        OR ($2 = 'prompt' AND listings.has_prompt)
        OR ($2 = 'workflow' AND listings.has_workflow)
        OR ($2 = 'files' AND listings.has_files)
        OR ($2 = 'notes' AND listings.has_notes)
        OR ($2 = 'remix' AND listings.has_remix)
      )
      AND (
        coalesce(nullif($3, ''), '') = ''
        OR listings.tool_slug = $3
      )
      %s
    ORDER BY %s
    OFFSET greatest(coalesce($5, 0), 0)
    LIMIT greatest(coalesce($6, 24), 1)
  $sql$, v_search_join, v_search_filter, v_order)
  USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit;
END;
$function$;

COMMENT ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) IS
  'F5b: marketplace listing. Filters and sorts entirely on the derived marketplace_bundle_listings index, so a page costs index entries proportional to p_limit rather than a per-row plpgsql quality predicate across the catalog. Verify with a seeded large catalog -- production per-call blocks are planning plus a PostgREST floor and will not move.';

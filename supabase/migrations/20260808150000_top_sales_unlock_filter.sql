-- Let the top-sales RPC carry the unlock filter, so filtered marketplace tabs
-- stop scanning the whole catalog.
--
-- `list_showcase_top_sales_post_ids` already serves unfiltered top-sales in
-- index order, but any request with an unlock or resource filter fell into
-- `collectFilteredFeedItems` with `mustScanAllCandidates = true` — every public
-- post fetched and hydrated per request, because the sort had to happen after
-- the filter. The unlock filter is pure column predicates on the bundle join
-- that already exists here, so it moves into SQL. Resource-kind filtering
-- deliberately does NOT: `getPostResourceKinds` is a multi-fallback derivation
-- over the bundle's resource JSON, and reimplementing it in SQL would fork
-- business logic the app keeps in one place. The app instead streams this
-- function's sales-ordered ids and filters as it goes — order comes from the
-- database, so filtering preserves it and can stop early.
--
-- The four-parameter signature is dropped rather than left as an overload:
-- PostgREST would see a four-argument call match both functions (the new one
-- via its default) and reject the call as ambiguous. An app calling with four
-- named arguments resolves against the new function with p_unlock_filter
-- defaulting to 'all', so the release window between migration and promote
-- keeps working.

DROP FUNCTION IF EXISTS public.list_showcase_top_sales_post_ids(text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.list_showcase_top_sales_post_ids(
  p_category text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 25,
  p_unlock_filter text DEFAULT 'all'
)
RETURNS TABLE(post_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT posts.id
  FROM public.posts AS posts
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.post_id = posts.id
   AND bundles.status = 'published'
  WHERE posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND coalesce(posts.review_status, 'visible') = 'visible'
    AND (
      coalesce(p_category, 'all') = 'all'
      OR (
        p_category = 'text'
        AND (posts.category = 'text' OR posts.post_format = 'mixed')
      )
      OR (
        p_category IN ('image', 'video')
        AND (
          EXISTS (
            SELECT 1
            FROM public.post_media AS media
            WHERE media.post_id = posts.id
              AND media.media_kind = p_category
          )
          OR (
            NOT EXISTS (
              SELECT 1
              FROM public.post_media AS media
              WHERE media.post_id = posts.id
            )
            AND CASE
              WHEN posts.category IN ('video', 'motion', 'ugc-ad') THEN 'video'
              ELSE 'image'
            END = p_category
          )
        )
      )
      OR (
        p_category NOT IN ('all', 'text', 'image', 'video')
        AND posts.category = p_category
      )
    )
    AND (
      nullif(btrim(coalesce(p_tool_slug, '')), '') IS NULL
      OR coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) = p_tool_slug
    )
    -- Mirrors itemMatchesUnlockFilters in showcase-feed.ts: with-unlock means a
    -- published bundle exists; free/paid match its access mode. The join is
    -- already restricted to published bundles, so a bundle row present IS the
    -- "has unlock" predicate.
    AND (
      coalesce(p_unlock_filter, 'all') = 'all'
      OR (p_unlock_filter = 'with-unlock' AND bundles.post_id IS NOT NULL)
      OR (p_unlock_filter IN ('free', 'paid') AND bundles.access_mode = p_unlock_filter)
    )
  ORDER BY
    coalesce(bundles.sales_count, 0) DESC,
    posts.created_at DESC,
    posts.id DESC
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 101);
$$;

REVOKE ALL ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_showcase_top_sales_post_ids(text, text, integer, integer, text) TO service_role;

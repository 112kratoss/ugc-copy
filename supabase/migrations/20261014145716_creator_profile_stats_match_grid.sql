-- The creator page's header and tab counts come from get_creator_profile_stats,
-- and they disagreed with the grid drawn under them (profiles compare
-- 2026-10-14, finding 02-2):
--
-- * "Recipes" also counted every post with a generation and an in-app source
--   kind that had no bundle. That branch mirrored the generation-recipe assets
--   the creator page attached until 2026-07-18; since then a tile carries a
--   recipe only when its post has a published bundle
--   (getMarketplaceAssetSummaryHydration). Every post published from the app
--   has such a source kind, so a creator who posts from the app saw
--   "Recipes N" over "No recipes yet" with every page loaded, and the web's
--   Recipes tab walked every page looking for them.
-- * Every count took in flagged posts. The grid, the TypeScript fallback that
--   runs when this function is missing and the indexing count all read
--   review_status = 'visible' (src/lib/creator-profile.ts), so "Posts" could
--   name posts no visitor can see.
--
-- Both rules now follow the grid. The signature, the JSON keys and the
-- service-role-only grant are unchanged.

CREATE OR REPLACE FUNCTION public.get_creator_profile_stats(p_creator_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH visible_posts AS MATERIALIZED (
    SELECT
      posts.id,
      posts.save_count,
      posts.remix_count,
      posts.source_tool,
      coalesce(
        nullif(posts.source_tool_slug, ''),
        lower(regexp_replace(btrim(coalesce(posts.source_tool, '')), '[^a-z0-9]+', '-', 'g'))
      ) AS tool_slug
    FROM public.posts AS posts
    WHERE posts.user_id = p_creator_id
      AND posts.visibility = 'public'
      AND posts.archived_at IS NULL
      AND posts.review_status = 'visible'
  ), post_stats AS (
    SELECT
      count(*)::integer AS public_creations,
      coalesce(sum(visible_posts.save_count), 0)::bigint AS total_saves,
      coalesce(sum(visible_posts.remix_count), 0)::bigint AS total_remixes,
      -- post_resource_bundles.post_id is unique, so the join adds no rows.
      count(*) FILTER (WHERE bundles.status = 'published')::integer AS unlocks,
      coalesce(sum(bundles.sales_count) FILTER (WHERE bundles.status = 'published'), 0)::bigint
        AS total_unlock_sales
    FROM visible_posts
    LEFT JOIN public.post_resource_bundles AS bundles
      ON bundles.post_id = visible_posts.id
  ), tool_counts AS (
    SELECT
      visible_posts.tool_slug AS slug,
      coalesce(
        max(nullif(btrim(visible_posts.source_tool), '')),
        visible_posts.tool_slug
      ) AS label,
      count(*)::integer AS count
    FROM visible_posts
    WHERE nullif(visible_posts.tool_slug, '') IS NOT NULL
    GROUP BY visible_posts.tool_slug
  ), tools AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('slug', slug, 'label', label, 'count', count)
        ORDER BY count DESC, label ASC
      ),
      '[]'::jsonb
    ) AS value
    FROM tool_counts
  )
  SELECT jsonb_build_object(
    'publicCreations', post_stats.public_creations,
    'totalSaves', post_stats.total_saves,
    'totalRemixes', post_stats.total_remixes,
    'unlocks', post_stats.unlocks,
    'totalUnlockSales', post_stats.total_unlock_sales,
    'toolsUsed', tools.value
  )
  FROM post_stats
  CROSS JOIN tools;
$$;

REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_creator_profile_stats(uuid) TO service_role;

COMMENT ON FUNCTION public.get_creator_profile_stats(uuid) IS
  'Backend-only creator page totals over the posts the creator grid shows (public, unarchived, review_status visible); unlocks counts published recipe bundles only. Read by src/lib/creator-profile.ts for the first page.';

import 'server-only';

import { unstable_cache } from 'next/cache';

import { getCreatorDisplayName } from '@/lib/profile';
import {
  deriveTitleFromBody,
  getMarketplaceAssetSummaryMap,
  getPostMediaKind,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
} from '@/lib/posts-server';
import {
  createServiceClient,
  resolveStoredMediaUrl,
} from '@/lib/server-helpers';
import {
  getPostResourceBundlePriceQuote,
  getPublicGenerationRecipeAssetSummaryMap,
} from '@/lib/post-resource-bundles-server';
import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import {
  MAGICBOOKLET_SOURCE_KIND,
  isGenerationRecipeAssetId,
  normalizeShowcaseSourceKind,
  sanitizeShowcaseFeedPage,
  type RawShowcaseSourceKind,
  type ShowcaseCategory,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
  type ShowcaseResourceFilter,
  type ShowcaseItemCategory,
  type ShowcasePostFormat,
  type ShowcaseSort,
  type ShowcaseUnlockFilter,
} from '@/lib/showcase';
import { slugifySourceTool } from '@/lib/source-tools';

interface ProfileSummary {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface PostRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  post_format: ShowcasePostFormat;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  user_id: string | null;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug: string | null;
  review_status?: string | null;
  generation_id: string | null;
}

interface LegacyPostRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  user_id: string | null;
  source_kind: RawShowcaseSourceKind;
  source_tool: string | null;
  source_tool_slug?: string | null;
  generation_id: string | null;
}

interface LegacyGenerationRow {
  id: string;
  output_url: string | null;
  showcase_asset_path?: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  user_id: string | null;
}

const FILTERED_FEED_BATCH_SIZE = 48;

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }

  return 'image';
}

async function fetchPostRows(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number,
  toolSlug: string | null
): Promise<PostRow[] | null> {
  const adminSupabase = createServiceClient();
  let query = adminSupabase
    .from('posts')
    .select('id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id')
    .eq('visibility', 'public')
    .is('archived_at', null);

  if (category === 'text') {
    query = query.or('category.eq.text,post_format.eq.mixed');
  } else if (category !== 'all') {
    query = query.eq('category', category);
  }

  if (toolSlug) {
    query = query.eq('source_tool_slug', toolSlug);
  }

  if (sort === 'top-saves') {
    query = query
      .order('save_count', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
  } else if (sort === 'top-remixes') {
    query = query
      .order('remix_count', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
  } else {
    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
  }

  const result = await query.range(offset, offset + limit - 1);

  if (isMissingPostTextColumnsError(result.error) || (result.error?.code === '42703' && `${result.error.message ?? ''}`.match(/source_tool_slug|review_status/))) {
    if (category === 'text') {
      return [];
    }

    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
      .eq('visibility', 'public')
      .is('archived_at', null);

    if (category !== 'all') {
      legacyQuery = legacyQuery.eq('category', category);
    }

    if (sort === 'top-saves') {
      legacyQuery = legacyQuery
        .order('save_count', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    } else if (sort === 'top-remixes') {
      legacyQuery = legacyQuery
        .order('remix_count', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    } else {
      legacyQuery = legacyQuery
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    }

    const legacyResult = await legacyQuery.range(offset, offset + limit - 1);
    if (legacyResult.error) {
      console.error('Error fetching showcase feed:', legacyResult.error);
      throw legacyResult.error;
    }

    return ((legacyResult.data ?? []) as LegacyPostRow[]).map((row) => ({
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
      source_tool_slug: slugifySourceTool(row.source_tool),
    }));
  }

  if (result.error) {
    if (isMissingPostsSchemaError(result.error)) {
      return null;
    }

    console.error('Error fetching showcase feed:', result.error);
    throw result.error;
  }

  return (result.data ?? []) as PostRow[];
}

function itemMatchesFeedFilters(
  item: ShowcaseFeedItem,
  unlockFilter: ShowcaseUnlockFilter,
  resourceFilter: ShowcaseResourceFilter
): boolean {
  if (unlockFilter === 'with-unlock' && !item.asset) {
    return false;
  }

  if ((unlockFilter === 'free' || unlockFilter === 'paid') && item.asset?.accessMode !== unlockFilter) {
    return false;
  }

  if (resourceFilter !== 'all') {
    const resourceKinds = item.asset?.resourceKinds ?? (item.asset?.allowRemix ? ['remix'] : []);
    if (!resourceKinds.includes(resourceFilter)) {
      return false;
    }
  }

  return true;
}

function compareByTopSales(left: ShowcaseFeedItem, right: ShowcaseFeedItem) {
  return (right.asset?.salesCount ?? 0) - (left.asset?.salesCount ?? 0)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

function buildAvailableTools(items: ShowcaseFeedItem[]) {
  const availableToolCounts = new Map<string, number>();
  for (const item of items) {
    if (item.sourceToolSlug) {
      availableToolCounts.set(item.sourceToolSlug, (availableToolCounts.get(item.sourceToolSlug) ?? 0) + 1);
    }
  }

  return Array.from(availableToolCounts.entries()).map(([slug, count]) => ({
    slug,
    label: items.find((item) => item.sourceToolSlug === slug)?.sourceTool ?? slug,
    count,
  }));
}

async function resolvePostRowsToFeedItems(
  rows: PostRow[],
  adminSupabase: ReturnType<typeof createServiceClient>
): Promise<ShowcaseFeedItem[]> {
  const visibleRows = rows.filter((row) => row.review_status !== 'hidden');
  const userIds = Array.from(new Set(visibleRows.map((row) => row.user_id).filter(Boolean))) as string[];
  const generationIds = Array.from(new Set(visibleRows.map((row) => row.generation_id).filter(Boolean))) as string[];

  const profilesMap: Record<string, ProfileSummary> = {};
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await adminSupabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    if (profilesError) {
      console.error('Error fetching showcase creator profiles:', profilesError);
    } else {
      for (const profile of profiles ?? []) {
        profilesMap[profile.id] = profile;
      }
    }
  }

  const generationModelMap = new Map<string, string>();
  if (generationIds.length > 0) {
    const { data: models, error: modelsError } = await adminSupabase
      .from('generations')
      .select('id, model')
      .in('id', generationIds);

    if (modelsError) {
      console.error('Error fetching showcase generation models:', modelsError);
    } else {
      for (const generation of models ?? []) {
        if (typeof generation.id === 'string' && typeof generation.model === 'string') {
          generationModelMap.set(generation.id, generation.model);
        }
      }
    }
  }

  const assetMap = await getMarketplaceAssetSummaryMap(
    visibleRows.map((row) => row.id),
    adminSupabase
  );
  const recipeAssetMap = await getPublicGenerationRecipeAssetSummaryMap(
    visibleRows.filter((row) => !assetMap.has(row.id)),
    adminSupabase
  );

  const sourceToolsMap = new Map<string, Array<{
    toolLabel: string;
    toolSlug?: string | null;
    modelLabel?: string | null;
    modelSlug?: string | null;
  }>>();
  try {
    const postIds = visibleRows.map((row) => row.id);
    const { data: sourceToolsRows, error: sourceToolsError } = await adminSupabase
      .from('post_source_tools')
      .select('post_id, tool_label, tool_slug, model_label, model_slug')
      .in('post_id', postIds)
      .order('sort_order', { ascending: true });
    if (sourceToolsError) {
      // Table may not exist yet; skip silently.
    } else {
      for (const row of (sourceToolsRows ?? []) as Array<{
        post_id: string; tool_label: string; tool_slug?: string | null;
        model_label?: string | null; model_slug?: string | null;
      }>) {
        const list = sourceToolsMap.get(row.post_id) ?? [];
        list.push({
          toolLabel: row.tool_label,
          toolSlug: row.tool_slug ?? null,
          modelLabel: row.model_label ?? null,
          modelSlug: row.model_slug ?? null,
        });
        if (!sourceToolsMap.has(row.post_id)) {
          sourceToolsMap.set(row.post_id, list);
        }
      }
    }
  } catch {
    // Non-critical; fall back to no source tools.
  }

  const resolvedItems = await Promise.all(
    visibleRows.map(async (post): Promise<ShowcaseFeedItem | null> => {
      const mediaUrl = await resolvePostMediaUrl(adminSupabase, post);
      if (post.post_format !== 'text' && !mediaUrl) {
        return null;
      }

      const profile = post.user_id ? profilesMap[post.user_id] : undefined;
      const asset = assetMap.get(post.id) ?? recipeAssetMap.get(post.id) ?? null;
      const body = post.body?.trim() || '';
      const model = post.generation_id
        ? generationModelMap.get(post.generation_id) ?? MAGICBOOKLET_SOURCE_KIND
        : post.source_kind === 'manual'
          ? 'manual'
          : post.source_tool ?? 'external';

      const remix = resolvePostRemixCapability({
        generationId: post.generation_id,
        postFormat: post.post_format,
        category: post.category,
        sourceKind: normalizeShowcaseSourceKind(post.source_kind),
        resourceBundle: asset
          ? {
              viewerCanAccess: isGenerationRecipeAssetId(asset.id),
              allowRemix: asset.allowRemix,
              items: asset.lockedPreview?.itemPreviews ?? [],
            }
          : null,
      });

      return {
        id: post.id,
        mediaUrl,
        mediaKind: getPostMediaKind(post.category, post.post_format),
        model,
        title: post.title?.trim() || deriveTitleFromBody(body) || (post.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation'),
        prompt: post.prompt || '',
        body,
        category: resolveItemCategory(post.category),
        postFormat: post.post_format,
        saveCount: post.save_count || 0,
        remixCount: post.remix_count || 0,
        createdAt: post.created_at,
        creator: {
          id: profile?.id ?? null,
          username: profile?.username ?? null,
          name: getCreatorDisplayName({
            displayName: profile?.display_name ?? null,
            username: profile?.username ?? null,
          }),
          avatar: profile?.avatar_url ?? null,
        },
        sourceKind: normalizeShowcaseSourceKind(post.source_kind),
        sourceTool: post.source_tool,
        sourceToolSlug: post.source_tool_slug ?? slugifySourceTool(post.source_tool),
        sourceTools: sourceToolsMap.get(post.id),
        generationId: post.generation_id,
        asset,
        canRemix: remix.capability === 'public' && remix.target !== 'workflow' && remix.target !== 'text_template',
        remixCapability: remix.capability,
        remixTarget: remix.target,
      };
    })
  );

  return resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);
}

async function collectFilteredFeedItems(params: {
  category: ShowcaseCategory;
  sort: ShowcaseSort;
  offset: number;
  limit: number;
  toolSlug: string | null;
  unlockFilter: ShowcaseUnlockFilter;
  resourceFilter: ShowcaseResourceFilter;
  adminSupabase: ReturnType<typeof createServiceClient>;
}): Promise<ShowcaseFeedPage | null> {
  const {
    category,
    sort,
    offset,
    limit,
    toolSlug,
    unlockFilter,
    resourceFilter,
    adminSupabase,
  } = params;
  const matchingItems: ShowcaseFeedItem[] = [];
  const batchSize = Math.max(FILTERED_FEED_BATCH_SIZE, limit * 4);
  const targetMatchCount = offset + limit + 1;
  const mustScanAllCandidates = sort === 'top-sales';
  let scanOffset = 0;
  let exhausted = false;

  while (!exhausted && (mustScanAllCandidates || matchingItems.length < targetMatchCount)) {
    const rows = await fetchPostRows(category, sort, scanOffset, batchSize, toolSlug);
    if (rows === null) {
      return null;
    }

    exhausted = rows.length < batchSize;
    scanOffset += rows.length;

    if (rows.length === 0) {
      break;
    }

    const items = await resolvePostRowsToFeedItems(rows, adminSupabase);
    matchingItems.push(
      ...items.filter((item) => itemMatchesFeedFilters(item, unlockFilter, resourceFilter))
    );
  }

  if (sort === 'top-sales') {
    matchingItems.sort(compareByTopSales);
  }

  const items = matchingItems.slice(offset, offset + limit);
  const hasMore = matchingItems.length > offset + limit;

  return {
    items,
    availableTools: buildAvailableTools(matchingItems),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      limit,
      offset,
    },
  };
}

async function getShowcaseFeedPageBase(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number,
  toolSlug: string | null,
  unlockFilter: ShowcaseUnlockFilter,
  resourceFilter: ShowcaseResourceFilter
): Promise<ShowcaseFeedPage> {
  const adminSupabase = createServiceClient();
  const needsFilteredScan = sort === 'top-sales' || unlockFilter !== 'all' || resourceFilter !== 'all';

  if (needsFilteredScan) {
    const filteredPage = await collectFilteredFeedItems({
      category,
      sort,
      offset,
      limit,
      toolSlug,
      unlockFilter,
      resourceFilter,
      adminSupabase,
    });

    if (filteredPage === null) {
      return getLegacyShowcaseFeedPageBase(category, sort, offset, limit);
    }

    return filteredPage;
  }

  const posts = await fetchPostRows(category, sort, offset, limit + 1, toolSlug);
  if (posts === null) {
    return getLegacyShowcaseFeedPageBase(category, sort, offset, limit);
  }

  const hasMore = posts.length > limit;
  const items = await resolvePostRowsToFeedItems(posts.slice(0, limit), adminSupabase);

  return {
    items,
    availableTools: buildAvailableTools(items),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      limit,
      offset,
    },
  };
}

async function fetchLegacyGenerationRows(
  adminSupabase: ReturnType<typeof createServiceClient>,
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number
) {
  if (category === 'text') {
    return [] as LegacyGenerationRow[];
  }

  const selectWithAsset = 'id, output_url, showcase_asset_path, model, prompt, title, category, save_count, remix_count, created_at, user_id';
  const selectWithoutAsset = 'id, output_url, model, prompt, title, category, save_count, remix_count, created_at, user_id';

  const buildQuery = (selectClause: string) => {
    let query = adminSupabase
      .from('generations')
      .select(selectClause)
      .eq('is_public', true)
      .eq('status', 'succeeded');

    if (category !== 'all') {
      query = query.eq('category', category);
    }

    if (sort === 'top-saves') {
      query = query
        .order('save_count', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    } else if (sort === 'top-remixes') {
      query = query
        .order('remix_count', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    } else {
      query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
    }

    return query.range(offset, offset + limit);
  };

  let result = await buildQuery(selectWithAsset);
  if (result.error?.code === '42703') {
    result = await buildQuery(selectWithoutAsset);
  }

  if (result.error) {
    console.error('Error fetching legacy showcase feed:', result.error);
    throw result.error;
  }

  return (result.data ?? []) as unknown as LegacyGenerationRow[];
}

async function getLegacyShowcaseFeedPageBase(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number
): Promise<ShowcaseFeedPage> {
  const adminSupabase = createServiceClient();
  const generations = await fetchLegacyGenerationRows(adminSupabase, category, sort, offset, limit);
  const hasMore = generations.length > limit;
  const visibleRows = hasMore ? generations.slice(0, limit) : generations;
  const userIds = Array.from(new Set(visibleRows.map((row) => row.user_id).filter(Boolean))) as string[];

  const profilesMap: Record<string, ProfileSummary> = {};
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await adminSupabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    if (profilesError) {
      console.error('Error fetching legacy showcase creator profiles:', profilesError);
    } else {
      for (const profile of profiles ?? []) {
        profilesMap[profile.id] = profile;
      }
    }
  }

  const resolvedItems = await Promise.all(
    visibleRows
      .map(async (generation): Promise<ShowcaseFeedItem | null> => {
        const mediaUrl = generation.showcase_asset_path
          ? adminSupabase.storage.from('showcase_media').getPublicUrl(generation.showcase_asset_path).data.publicUrl
          : generation.output_url
            ? await resolveStoredMediaUrl(adminSupabase, generation.output_url)
            : null;

        if (!mediaUrl) {
          return null;
        }

        const resolvedCategory = resolveItemCategory(generation.category);
        const profile = generation.user_id ? profilesMap[generation.user_id] : undefined;

        return {
          id: generation.id,
          mediaUrl,
          mediaKind: getPostMediaKind(resolvedCategory, 'media'),
          model: generation.model,
          title: generation.title || 'Untitled Creation',
          prompt: generation.prompt || '',
          body: '',
          category: resolvedCategory,
          postFormat: 'media',
          saveCount: generation.save_count || 0,
          remixCount: generation.remix_count || 0,
          createdAt: generation.created_at,
          creator: {
            id: profile?.id ?? null,
            username: profile?.username ?? null,
            name: getCreatorDisplayName({
              displayName: profile?.display_name ?? null,
              username: profile?.username ?? null,
            }),
            avatar: profile?.avatar_url ?? null,
          },
          sourceKind: MAGICBOOKLET_SOURCE_KIND,
          sourceTool: null,
          sourceToolSlug: 'magicbooklet',
          generationId: generation.id,
          asset: null,
          canRemix: true,
        };
      })
  );

  const items = resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);

  return {
    items,
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      limit,
      offset,
    },
  };
}

const getCachedShowcaseFeedPageBase = unstable_cache(
  getShowcaseFeedPageBase,
  ['showcase-feed-base'],
  { revalidate: 60 }
);

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

async function loadShowcaseFeedPageBase(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number,
  toolSlug: string | null,
  unlockFilter: ShowcaseUnlockFilter,
  resourceFilter: ShowcaseResourceFilter
): Promise<ShowcaseFeedPage> {
  try {
    return await getCachedShowcaseFeedPageBase(category, sort, offset, limit, toolSlug, unlockFilter, resourceFilter);
  } catch (error) {
    if (isMissingIncrementalCacheError(error)) {
      return getShowcaseFeedPageBase(category, sort, offset, limit, toolSlug, unlockFilter, resourceFilter);
    }

    throw error;
  }
}

export async function getShowcaseFeedPage(options: {
  category: ShowcaseCategory;
  sort: ShowcaseSort;
  offset: number;
  limit: number;
  viewerUserId?: string | null;
  tool?: string | null;
  unlock?: ShowcaseUnlockFilter;
  resource?: ShowcaseResourceFilter;
  countryCode?: string | null;
}): Promise<ShowcaseFeedPage> {
  const { category, sort, offset, limit } = options;
  const adminSupabase = createServiceClient();
  const viewerUserId = options.viewerUserId ?? null;
  const toolSlug = slugifySourceTool(options.tool);
  const unlockFilter = options.unlock ?? 'all';
  const resourceFilter = options.resource ?? 'all';
  const baseFeed = await loadShowcaseFeedPageBase(category, sort, offset, limit, toolSlug, unlockFilter, resourceFilter);
  const pricedFeed = await attachLocalizedAssetPrices(baseFeed, options.countryCode);
  const hydratedFeed = await attachViewerStateToFeed(pricedFeed, viewerUserId, adminSupabase);

  return sanitizeShowcaseFeedPage(hydratedFeed);
}

async function attachViewerStateToFeed(
  feed: ShowcaseFeedPage,
  viewerUserId: string | null,
  adminSupabase: ReturnType<typeof createServiceClient>
): Promise<ShowcaseFeedPage> {
  if (!viewerUserId || feed.items.length === 0) {
    return feed;
  }

  let savedItems: Array<{ post_id?: string; generation_id?: string }> | null = null;
  const { data: postSavedItems, error } = await adminSupabase
    .from('post_saves')
    .select('post_id')
    .eq('user_id', viewerUserId)
    .in('post_id', feed.items.map((item) => item.id));

  if (error && isMissingPostsSchemaError(error)) {
    const legacySavedResult = await adminSupabase
      .from('showcase_saves')
      .select('generation_id')
      .eq('user_id', viewerUserId)
      .in('generation_id', feed.items.map((item) => item.generationId ?? item.id));

    if (legacySavedResult.error) {
      console.error('Error fetching legacy showcase saved state for feed page:', legacySavedResult.error);
      return feed;
    }

    savedItems = legacySavedResult.data as Array<{ generation_id: string }> | null;
  } else if (error) {
    console.error('Error fetching showcase saved state for feed page:', error);
    return feed;
  } else {
    savedItems = postSavedItems as Array<{ post_id: string }> | null;
  }

  const savedIdSet = new Set(
    (savedItems ?? []).map((row) => row.post_id ?? row.generation_id).filter(Boolean)
  );
  const remixEligibleBundleIds = Array.from(
    new Set(
      feed.items
        .filter((item) => item.asset?.allowRemix)
        .map((item) => item.asset?.id)
        .filter((bundleId): bundleId is string => Boolean(bundleId))
    )
  );
  let purchasedBundleIdSet = new Set<string>();

  if (remixEligibleBundleIds.length > 0) {
    const { data: purchaseRows, error: purchaseError } = await adminSupabase
      .from('post_resource_bundle_purchases')
      .select('bundle_id')
      .eq('buyer_user_id', viewerUserId)
      .in('bundle_id', remixEligibleBundleIds);

    if (purchaseError) {
      console.error('Error fetching post resource bundle purchase state for feed page:', purchaseError);
    } else {
      purchasedBundleIdSet = new Set(
        ((purchaseRows ?? []) as Array<{ bundle_id?: string | null }>)
          .map((row) => row.bundle_id)
          .filter((bundleId): bundleId is string => Boolean(bundleId))
      );
    }
  }

  return {
    ...feed,
    items: feed.items.map((item) => {
      const viewerCanAccessBundle = Boolean(
        item.asset && (
          isGenerationRecipeAssetId(item.asset.id)
          || item.creator.id === viewerUserId
          || purchasedBundleIdSet.has(item.asset.id)
        )
      );
      const remix = resolvePostRemixCapability({
        generationId: item.generationId,
        postFormat: item.postFormat,
        category: item.category,
        sourceKind: item.sourceKind,
        resourceBundle: item.asset
          ? {
              viewerCanAccess: viewerCanAccessBundle,
              allowRemix: item.asset.allowRemix,
              items: item.asset.lockedPreview?.itemPreviews ?? [],
            }
          : null,
      });

      return {
        ...item,
        isSaved: savedIdSet.has(item.id) || (item.generationId ? savedIdSet.has(item.generationId) : false),
        canRemix: remix.capability === 'public' && remix.target !== 'workflow' && remix.target !== 'text_template',
        remixCapability: remix.capability,
        remixTarget: remix.target,
      };
    }),
  };
}

export async function getShowcaseFeedItemById(options: {
  postId: string;
  viewerUserId?: string | null;
  countryCode?: string | null;
}): Promise<ShowcaseFeedItem | null> {
  const { postId, viewerUserId = null, countryCode = null } = options;
  const adminSupabase = createServiceClient();
  let result = await adminSupabase
    .from('posts')
    .select('id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id')
    .eq('id', postId)
    .eq('visibility', 'public')
    .is('archived_at', null)
    .maybeSingle();

  if (isMissingPostTextColumnsError(result.error) || (result.error?.code === '42703' && `${result.error.message ?? ''}`.match(/source_tool_slug|review_status/))) {
    result = await adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
      .eq('id', postId)
      .eq('visibility', 'public')
      .is('archived_at', null)
      .maybeSingle();

    if (!result.error && result.data) {
      result = {
        ...result,
        data: {
          ...(result.data as LegacyPostRow),
          body: null,
          post_format: normalizeLegacyPostFormat((result.data as LegacyPostRow).category),
          source_tool_slug: slugifySourceTool((result.data as LegacyPostRow).source_tool),
          review_status: 'visible',
        },
      };
    }
  }

  if (result.error) {
    if (isMissingPostsSchemaError(result.error)) {
      return null;
    }

    console.error('Error fetching showcase post detail:', result.error);
    throw result.error;
  }

  const row = result.data as PostRow | null;
  if (!row) {
    return null;
  }

  const [item] = await resolvePostRowsToFeedItems([row], adminSupabase);
  if (!item) {
    return null;
  }

  const pricedFeed = await attachLocalizedAssetPrices({
    items: [item],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 1,
      offset: 0,
    },
  }, countryCode);
  const hydratedFeed = await attachViewerStateToFeed(pricedFeed, viewerUserId, adminSupabase);
  const sanitizedFeed = sanitizeShowcaseFeedPage(hydratedFeed);

  return sanitizedFeed.items[0] ?? null;
}

async function attachLocalizedAssetPrices(
  feed: ShowcaseFeedPage,
  countryCode?: string | null
): Promise<ShowcaseFeedPage> {
  const assets = feed.items
    .map((item) => item.asset)
    .filter((asset): asset is NonNullable<ShowcaseFeedItem['asset']> => Boolean(asset));

  if (assets.length === 0) {
    return feed;
  }

  const quoteByAssetId = new Map(
    await Promise.all(
      assets.map(async (asset) => [
        asset.id,
        await getPostResourceBundlePriceQuote(asset.priceUsdCents, countryCode),
      ] as const)
    )
  );

  return {
    ...feed,
    items: feed.items.map((item) => item.asset
      ? {
          ...item,
          asset: {
            ...item.asset,
            priceQuote: quoteByAssetId.get(item.asset.id),
          },
        }
      : item),
  };
}

import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { unstable_cache } from 'next/cache';

import { getCreatorDisplayName } from '@/lib/profile';
import {
  deriveTitleFromBody,
  getMarketplaceAssetSummaryHydration,
  getPostMediaKind,
  isMissingPostTextColumnsError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
  resolvePostMediaUrl,
} from '@/lib/posts-server';
import {
  buildLegacyPostMediaItems,
  loadPostMediaItemsMap,
} from '@/lib/post-media';
import {
  createServiceClient,
  resolveStoredMediaUrl,
} from '@/lib/server-helpers';
import {
  getPostResourceBundlePriceQuote,
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
import { getPersonalizedShowcaseFeedPage } from '@/lib/showcase-feed-personalization';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';
import { sanitizePublicPostContent } from '@/lib/post-public-content';
import { loadBlockedCreatorIds } from '@/lib/moderation-service';
import {
  shouldCacheIdentitylessForYouBootstrap,
  shouldCacheViewerNeutralShowcaseBasePage,
} from '@/lib/showcase-feed-cache-policy';

interface ProfileSummary {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface PostRow {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  prompt: string | null;
  title: string | null;
  body: string | null;
  category: ShowcaseItemCategory;
  creation_mode?: 'motion' | null;
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
  preview_url?: string | null;
  thumbnail_url?: string | null;
  model: string;
  prompt: string | null;
  title: string | null;
  category: string | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  user_id: string | null;
}

const FILTERED_FEED_BATCH_SIZE = 48;
type ShowcaseFeedHydrationCache = Map<string, ShowcaseFeedItem | null>;

function resolveItemCategory(category: string | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad') return 'video';
  if (category === 'text') return 'text';

  return 'image';
}

function isMissingGenerationPreviewColumnError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code, message = '' } = error as { code?: string; message?: string };
  return (
    (code === '42703' || code === 'PGRST204')
    && (message.includes('preview_url') || message.includes('thumbnail_url'))
  );
}

async function resolveLegacyGenerationPreviewUrl(
  adminSupabase: ReturnType<typeof createServiceClient>,
  generation: Pick<LegacyGenerationRow, 'preview_url' | 'thumbnail_url' | 'category'>,
  mediaUrl: string
) {
  const previewSource = generation.preview_url || generation.thumbnail_url || null;
  if (previewSource) {
    return resolveStoredMediaUrl(adminSupabase, previewSource);
  }

  return resolveItemCategory(generation.category) === 'image' ? mediaUrl : null;
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
    .select('id, output_url, showcase_asset_path, prompt, title, body, category, creation_mode, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id')
    .eq('visibility', 'public')
    .is('archived_at', null);

  if (category === 'text') {
    query = query.or('category.eq.text,post_format.eq.mixed');
  } else if (category !== 'all' && category !== 'image' && category !== 'video') {
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

  if (isMissingPostTextColumnsError(result.error) || (result.error?.code === '42703' && `${result.error.message ?? ''}`.match(/source_tool_slug|review_status|creation_mode/))) {
    if (category === 'text') {
      return [];
    }

    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
      .eq('visibility', 'public')
      .is('archived_at', null);

    if (category !== 'all' && category !== 'image' && category !== 'video') {
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
      logBackendError('error_fetching_showcase_feed', { error: legacyResult.error });
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

    logBackendError('error_fetching_showcase_feed', { error: result.error });
    throw result.error;
  }

  return (result.data ?? []) as PostRow[];
}

async function fetchPostRowsByIds(
  postIds: string[],
  adminSupabase = createServiceClient()
): Promise<PostRow[] | null> {
  if (postIds.length === 0) return [];

  const result = await adminSupabase
    .from('posts')
    .select('id, output_url, showcase_asset_path, prompt, title, body, category, creation_mode, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, source_tool_slug, review_status, generation_id')
    .in('id', postIds)
    .eq('visibility', 'public')
    .is('archived_at', null);

  if (isMissingPostTextColumnsError(result.error) || (result.error?.code === '42703' && `${result.error.message ?? ''}`.match(/source_tool_slug|review_status|creation_mode/))) {
    const legacyResult = await adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
      .in('id', postIds)
      .eq('visibility', 'public')
      .is('archived_at', null);
    if (legacyResult.error) {
      if (isMissingPostsSchemaError(legacyResult.error)) return null;
      throw legacyResult.error;
    }
    const rowById = new Map(((legacyResult.data ?? []) as LegacyPostRow[]).map((row) => [row.id, row]));
    return postIds.flatMap((postId) => {
      const row = rowById.get(postId);
      return row ? [{
        ...row,
        body: null,
        creation_mode: null,
        post_format: normalizeLegacyPostFormat(row.category),
        source_tool_slug: slugifySourceTool(row.source_tool),
        review_status: 'visible',
      }] : [];
    });
  }

  if (result.error) {
    if (isMissingPostsSchemaError(result.error)) return null;
    throw result.error;
  }

  const rowById = new Map(((result.data ?? []) as PostRow[]).map((row) => [row.id, row]));
  return postIds.flatMap((postId) => {
    const row = rowById.get(postId);
    return row ? [row] : [];
  });
}

function itemMatchesFeedFilters(
  item: ShowcaseFeedItem,
  category: ShowcaseCategory,
  unlockFilter: ShowcaseUnlockFilter,
  resourceFilter: ShowcaseResourceFilter
): boolean {
  if (!itemMatchesCategory(item, category)) {
    return false;
  }

  return itemMatchesUnlockFilters(item, unlockFilter, resourceFilter);
}

function itemMatchesCategory(item: ShowcaseFeedItem, category: ShowcaseCategory): boolean {
  if (category === 'all') {
    return true;
  }

  if (category === 'image' || category === 'video') {
    return item.mediaItems?.some((mediaItem) => mediaItem.mediaKind === category)
      || item.mediaKind === category;
  }

  if (category === 'text') {
    return item.category === 'text' || item.postFormat === 'mixed';
  }

  return item.category === category;
}

function itemMatchesUnlockFilters(
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

function isMissingShowcaseTopSalesRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === '42883'
    || candidate.code === 'PGRST202'
    || Boolean(candidate.message?.includes('list_showcase_top_sales_post_ids'))
  );
}

async function getShowcaseTopSalesPage(params: {
  adminSupabase: ReturnType<typeof createServiceClient>;
  category: ShowcaseCategory;
  limit: number;
  offset: number;
  toolSlug: string | null;
}): Promise<ShowcaseFeedPage | null> {
  const { adminSupabase, category, limit, offset, toolSlug } = params;
  if (typeof (adminSupabase as unknown as { rpc?: unknown }).rpc !== 'function') return null;
  const { data, error } = await adminSupabase.rpc('list_showcase_top_sales_post_ids', {
    p_category: category,
    p_tool_slug: toolSlug,
    p_offset: offset,
    p_limit: limit + 1,
  });

  if (error) {
    if (isMissingShowcaseTopSalesRpcError(error)) return null;
    throw error;
  }

  const postIds = ((data ?? []) as Array<{ post_id?: string | null }>)
    .map((row) => row.post_id)
    .filter((postId): postId is string => Boolean(postId));
  const hasMore = postIds.length > limit;
  const pagePostIds = postIds.slice(0, limit);
  const rows = await fetchPostRowsByIds(pagePostIds, adminSupabase);
  if (rows === null) return null;

  const resolvedItems = await resolvePostRowsToFeedItems(rows, adminSupabase);
  const itemById = new Map(resolvedItems.map((item) => [item.id, item]));
  const items = pagePostIds.flatMap((postId) => {
    const item = itemById.get(postId);
    return item ? [item] : [];
  });
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

export async function resolvePostRowsToFeedItems(
  rows: PostRow[],
  adminSupabase: ReturnType<typeof createServiceClient>,
  hydrationCache?: ShowcaseFeedHydrationCache,
): Promise<ShowcaseFeedItem[]> {
  const visibleRows = rows.filter((row) => !row.review_status || row.review_status === 'visible');
  const pendingPostIds = new Set<string>();
  const rowsToHydrate = hydrationCache
    ? visibleRows.filter((row) => {
        if (hydrationCache.has(row.id) || pendingPostIds.has(row.id)) return false;
        pendingPostIds.add(row.id);
        return true;
      })
    : visibleRows;
  if (rowsToHydrate.length === 0) {
    return visibleRows.flatMap((row) => {
      const item = hydrationCache?.get(row.id);
      return item ? [item] : [];
    });
  }

  const userIds = Array.from(new Set(rowsToHydrate.map((row) => row.user_id).filter(Boolean))) as string[];
  const generationIds = Array.from(new Set(rowsToHydrate.map((row) => row.generation_id).filter(Boolean))) as string[];

  const loadProfiles = async () => {
    const profilesMap: Record<string, ProfileSummary> = {};
    if (userIds.length === 0) return profilesMap;

    const { data: profiles, error: profilesError } = await adminSupabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds);

    if (profilesError) {
      logBackendError('error_fetching_showcase_creator_profiles', { error: profilesError });
    } else {
      for (const profile of profiles ?? []) {
        profilesMap[profile.id] = profile;
      }
    }
    return profilesMap;
  };

  const loadGenerationInfo = async () => {
    const generationInfoMap = new Map<string, { model: string; previewUrl: string | null }>();
    if (generationIds.length === 0) return generationInfoMap;

    type GenerationInfoRow = {
      id: string;
      model: string;
      preview_url?: string | null;
      thumbnail_url?: string | null;
      category?: string | null;
    };

    const modelsWithPreviewResult = await adminSupabase
      .from('generations')
      .select('id, model, preview_url, thumbnail_url, category')
      .in('id', generationIds);
    let models = modelsWithPreviewResult.data as GenerationInfoRow[] | null;
    let modelsError = modelsWithPreviewResult.error;

    if (isMissingGenerationPreviewColumnError(modelsError)) {
      const legacyModelsResult = await adminSupabase
        .from('generations')
        .select('id, model')
        .in('id', generationIds);
      models = legacyModelsResult.data as GenerationInfoRow[] | null;
      modelsError = legacyModelsResult.error;
    }

    if (modelsError) {
      logBackendError('error_fetching_showcase_generation_models', { error: modelsError });
    } else {
      const entries = await Promise.all((models ?? []).flatMap((generation) => {
        if (typeof generation.id !== 'string' || typeof generation.model !== 'string') return [];
        const previewSource =
          typeof generation.preview_url === 'string' && generation.preview_url
            ? generation.preview_url
            : typeof generation.thumbnail_url === 'string' && generation.thumbnail_url
              ? generation.thumbnail_url
              : null;
        return [Promise.resolve(previewSource ? resolveStoredMediaUrl(adminSupabase, previewSource) : null)
          .then((previewUrl) => [generation.id, { model: generation.model, previewUrl }] as const)];
      }));
      for (const [generationId, generationInfo] of entries) {
        generationInfoMap.set(generationId, generationInfo);
      }
    }
    return generationInfoMap;
  };

  const loadSourceTools = async () => {
    const sourceToolsMap = new Map<string, Array<{
      toolLabel: string;
      toolSlug?: string | null;
      modelLabel?: string | null;
      modelSlug?: string | null;
    }>>();
    try {
    const postIds = rowsToHydrate.map((row) => row.id);
    if (postIds.length === 0) return sourceToolsMap;
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
    return sourceToolsMap;
  };

  const postIds = rowsToHydrate.map((row) => row.id);
  const assetHydrationPromise = getMarketplaceAssetSummaryHydration(postIds, adminSupabase);
  const assetMapPromise = assetHydrationPromise.then(({ assetMap }) => assetMap);
  const [
    profilesMap,
    generationInfoMap,
    assetMap,
    mediaItemsMap,
    sourceToolsMap,
  ] = await Promise.all([
    loadProfiles(),
    loadGenerationInfo(),
    assetMapPromise,
    loadPostMediaItemsMap(adminSupabase, postIds),
    loadSourceTools(),
  ]);

  const resolvedItems = await Promise.all(
    rowsToHydrate.map(async (post): Promise<ShowcaseFeedItem | null> => {
      let mediaItems = mediaItemsMap.get(post.id) ?? await buildLegacyPostMediaItems({
        supabase: adminSupabase,
        postId: post.id,
        row: post,
      });
      const generationInfo = post.generation_id ? generationInfoMap.get(post.generation_id) : null;
      if (generationInfo?.previewUrl && mediaItems[0] && !mediaItems[0].previewUrl) {
        mediaItems = [
          { ...mediaItems[0], previewUrl: generationInfo.previewUrl },
          ...mediaItems.slice(1),
        ];
      }
      const coverMedia = mediaItems[0] ?? null;
      const mediaUrl = coverMedia?.url ?? await resolvePostMediaUrl(adminSupabase, post);
      const mediaKind = coverMedia?.mediaKind ?? getPostMediaKind(post.category, post.post_format);
      if (post.post_format !== 'text' && !mediaUrl) {
        return null;
      }

      const profile = post.user_id ? profilesMap[post.user_id] : undefined;
      const asset = assetMap.get(post.id) ?? null;
      const publicContent = sanitizePublicPostContent({
        prompt: post.prompt?.trim() || '',
        body: post.body?.trim() || '',
        description: '',
        hasRecipe: Boolean(asset),
        isPaidRecipe: asset?.accessMode === 'paid',
      });
      const body = publicContent.body;
      const model = post.generation_id
        ? generationInfo?.model ?? MAGICBOOKLET_SOURCE_KIND
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
        mediaKind,
        mediaItems,
        model,
        title: post.title?.trim() || deriveTitleFromBody(body) || (post.post_format === 'text' ? 'Untitled Note' : 'Untitled Creation'),
        prompt: publicContent.prompt,
        body,
        category: resolveItemCategory(post.category),
        creationMode: post.creation_mode ?? ((post.category as string) === 'motion' ? 'motion' : null),
        postFormat: post.post_format,
        saveCount: post.save_count || 0,
        remixCount: post.remix_count || 0,
        createdAt: post.created_at,
        creator: {
          id: profile?.id ?? post.user_id ?? null,
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

  if (!hydrationCache) {
    return resolvedItems.filter((item): item is ShowcaseFeedItem => item !== null);
  }

  resolvedItems.forEach((item, index) => {
    const postId = rowsToHydrate[index]?.id;
    if (postId) hydrationCache.set(postId, item);
  });
  return visibleRows.flatMap((row) => {
    const item = hydrationCache.get(row.id);
    return item ? [item] : [];
  });
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
  hydrationCache?: ShowcaseFeedHydrationCache;
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
    hydrationCache,
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

    const items = await resolvePostRowsToFeedItems(rows, adminSupabase, hydrationCache);
    matchingItems.push(
      ...items.filter((item) => itemMatchesFeedFilters(item, category, unlockFilter, resourceFilter))
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
  resourceFilter: ShowcaseResourceFilter,
  hydrationCache?: ShowcaseFeedHydrationCache,
): Promise<ShowcaseFeedPage> {
  const adminSupabase = createServiceClient();
  if (sort === 'top-sales' && unlockFilter === 'all' && resourceFilter === 'all') {
    const topSalesPage = await getShowcaseTopSalesPage({
      adminSupabase,
      category,
      limit,
      offset,
      toolSlug,
    });
    if (topSalesPage) return topSalesPage;
  }

  const needsFilteredScan =
    sort === 'top-sales' ||
    unlockFilter !== 'all' ||
    resourceFilter !== 'all' ||
    category === 'image' ||
    category === 'video';

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
      hydrationCache,
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
  const resolvedItems = await resolvePostRowsToFeedItems(
    posts.slice(0, limit),
    adminSupabase,
    hydrationCache,
  );
  const items = resolvedItems.filter((item) => itemMatchesCategory(item, category));

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

  const selectWithAssetAndPreview = 'id, output_url, showcase_asset_path, preview_url, thumbnail_url, model, prompt, title, category, save_count, remix_count, created_at, user_id';
  const selectWithAsset = 'id, output_url, showcase_asset_path, model, prompt, title, category, save_count, remix_count, created_at, user_id';
  const selectWithoutAssetAndPreview = 'id, output_url, preview_url, thumbnail_url, model, prompt, title, category, save_count, remix_count, created_at, user_id';
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

  let result = await buildQuery(selectWithAssetAndPreview);
  if (isMissingGenerationPreviewColumnError(result.error)) {
    result = await buildQuery(selectWithAsset);
  }
  if (result.error?.code === '42703') {
    result = await buildQuery(selectWithoutAssetAndPreview);
  }
  if (isMissingGenerationPreviewColumnError(result.error)) {
    result = await buildQuery(selectWithoutAsset);
  }

  if (result.error) {
    logBackendError('error_fetching_legacy_showcase_feed', { error: result.error });
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
      logBackendError('error_fetching_legacy_showcase_creator_profiles', { error: profilesError });
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
        const previewUrl = await resolveLegacyGenerationPreviewUrl(adminSupabase, generation, mediaUrl);
        const profile = generation.user_id ? profilesMap[generation.user_id] : undefined;

        return {
          id: generation.id,
          mediaUrl,
          mediaKind: getPostMediaKind(resolvedCategory, 'media'),
          mediaItems: [{
            id: `${generation.id}:cover`,
            mediaKey: 'media-1',
            url: mediaUrl,
            previewUrl,
            mediaKind: getPostMediaKind(resolvedCategory, 'media') ?? 'image',
            contentType: null,
            originalName: null,
            width: null,
            height: null,
            durationSeconds: null,
            sortOrder: 0,
          }],
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
            id: profile?.id ?? generation.user_id ?? null,
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
  ['showcase-feed-base-v2'],
  { revalidate: 60, tags: [SHOWCASE_FEED_CACHE_TAG] }
);

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

async function getShowcaseForYouFeedPage(params: {
  category: ShowcaseCategory;
  offset: number;
  limit: number;
  toolSlug: string | null;
  unlockFilter: ShowcaseUnlockFilter;
  resourceFilter: ShowcaseResourceFilter;
  viewerUserId: string | null;
  anonymousKeyHash: string | null;
  cursor: string | null;
  adminSupabase?: ReturnType<typeof createServiceClient>;
}): Promise<ShowcaseFeedPage> {
  const adminSupabase = params.adminSupabase ?? createServiceClient();
  const hydrationCache: ShowcaseFeedHydrationCache = new Map();

  return getPersonalizedShowcaseFeedPage({
    anonymousKeyHash: params.anonymousKeyHash,
    cursor: params.cursor,
    filters: {
      category: params.category,
      toolSlug: params.toolSlug,
      unlockFilter: params.unlockFilter,
      resourceFilter: params.resourceFilter,
    },
    hydratePostIds: async (postIds) => {
      const rows = await fetchPostRowsByIds(postIds, adminSupabase);
      if (rows === null) return [];
      const items = await resolvePostRowsToFeedItems(rows, adminSupabase, hydrationCache);
      for (const postId of postIds) {
        if (!hydrationCache.has(postId)) hydrationCache.set(postId, null);
      }
      return items.filter((item) => (
        (!params.toolSlug || item.sourceToolSlug === params.toolSlug)
        && itemMatchesFeedFilters(
          item,
          params.category,
          params.unlockFilter,
          params.resourceFilter
        )
      ));
    },
    fallbackItems: async (target) => {
      const page = await getShowcaseFeedPageBase(
        params.category,
        'recent',
        0,
        target,
        params.toolSlug,
        params.unlockFilter,
        params.resourceFilter,
        hydrationCache,
      );
      return page.items;
    },
    limit: params.limit,
    offset: params.offset,
    serviceClient: adminSupabase,
    viewerUserId: params.viewerUserId,
  });
}

const getCachedIdentitylessShowcaseForYouBootstrap = unstable_cache(
  async (
    category: ShowcaseCategory,
    limit: number,
    unlockFilter: ShowcaseUnlockFilter,
    resourceFilter: ShowcaseResourceFilter,
  ) => getShowcaseForYouFeedPage({
    category,
    offset: 0,
    limit,
    toolSlug: null,
    unlockFilter,
    resourceFilter,
    viewerUserId: null,
    anonymousKeyHash: null,
    cursor: null,
  }),
  ['showcase-for-you-bootstrap-v2'],
  { revalidate: 60, tags: [SHOWCASE_FEED_CACHE_TAG] }
);

async function loadIdentitylessShowcaseForYouBootstrap(
  category: ShowcaseCategory,
  limit: number,
  unlockFilter: ShowcaseUnlockFilter,
  resourceFilter: ShowcaseResourceFilter,
) {
  try {
    return await getCachedIdentitylessShowcaseForYouBootstrap(
      category,
      limit,
      unlockFilter,
      resourceFilter,
    );
  } catch (error) {
    if (isMissingIncrementalCacheError(error)) {
      return getShowcaseForYouFeedPage({
        category,
        offset: 0,
        limit,
        toolSlug: null,
        unlockFilter,
        resourceFilter,
        viewerUserId: null,
        anonymousKeyHash: null,
        cursor: null,
      });
    }

    throw error;
  }
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
  anonymousKeyHash?: string | null;
  cursor?: string | null;
  requestId?: string | null;
  tool?: string | null;
  unlock?: ShowcaseUnlockFilter;
  resource?: ShowcaseResourceFilter;
  countryCode?: string | null;
  bypassCache?: boolean;
}): Promise<ShowcaseFeedPage> {
  const { category, sort, offset, limit } = options;
  const adminSupabase = createServiceClient();
  const viewerUserId = options.viewerUserId ?? null;
  const toolSlug = slugifySourceTool(options.tool);
  const unlockFilter = options.unlock ?? 'all';
  const resourceFilter = options.resource ?? 'all';
  const baseFeed = sort === 'for-you'
    ? shouldCacheIdentitylessForYouBootstrap({
      sort,
      offset,
      limit,
      toolSlug,
      viewerUserId,
      anonymousKeyHash: options.anonymousKeyHash,
      cursor: options.cursor,
      bypassCache: options.bypassCache,
    })
      ? await loadIdentitylessShowcaseForYouBootstrap(
        category,
        limit,
        unlockFilter,
        resourceFilter,
      )
      : await getShowcaseForYouFeedPage({
        category,
        offset,
        limit,
        toolSlug,
        unlockFilter,
        resourceFilter,
        viewerUserId,
        anonymousKeyHash: options.anonymousKeyHash ?? null,
        cursor: options.cursor ?? null,
        adminSupabase,
      })
    : shouldCacheViewerNeutralShowcaseBasePage({
      offset,
      limit,
      toolSlug,
      bypassCache: options.bypassCache,
    })
      ? await loadShowcaseFeedPageBase(category, sort, offset, limit, toolSlug, unlockFilter, resourceFilter)
      : await getShowcaseFeedPageBase(category, sort, offset, limit, toolSlug, unlockFilter, resourceFilter);
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

  let viewerSafeItems = feed.items;
  try {
    const blockedCreatorIds = await loadBlockedCreatorIds({
      adminSupabase,
      creatorIds: feed.items
        .map((item) => item.creator.id)
        .filter((id): id is string => Boolean(id)),
      viewerUserId,
    });
    viewerSafeItems = feed.items.filter((item) => (
      !item.creator.id || !blockedCreatorIds.has(item.creator.id)
    ));
  } catch (error) {
    // Blocking is a user-safety boundary. Fail closed for authenticated feeds
    // rather than returning content from a relationship we could not verify.
    logBackendError('error_filtering_blocked_creators_from_showcase_feed', { error: error });
    viewerSafeItems = [];
  }

  if (viewerSafeItems.length === 0) {
    return { ...feed, items: [] };
  }

  const remixEligibleBundleIds = Array.from(
    new Set(
      viewerSafeItems
        .filter((item) => item.asset?.allowRemix)
        .map((item) => item.asset?.id)
        .filter((bundleId): bundleId is string => Boolean(bundleId) && !isGenerationRecipeAssetId(bundleId))
    )
  );
  const loadSavedIds = async () => {
    let savedItems: Array<{ post_id?: string; generation_id?: string }> | null = null;
    const { data: postSavedItems, error } = await adminSupabase
      .from('post_saves')
      .select('post_id')
      .eq('user_id', viewerUserId)
      .in('post_id', viewerSafeItems.map((item) => item.id));

    if (error && isMissingPostsSchemaError(error)) {
      const legacySavedResult = await adminSupabase
        .from('showcase_saves')
        .select('generation_id')
        .eq('user_id', viewerUserId)
        .in('generation_id', viewerSafeItems.map((item) => item.generationId ?? item.id));

      if (legacySavedResult.error) {
        logBackendError('error_fetching_legacy_showcase_saved_state_for_feed_page', { error: legacySavedResult.error });
        return new Set<string>();
      }
      savedItems = legacySavedResult.data as Array<{ generation_id: string }> | null;
    } else if (error) {
      logBackendError('error_fetching_showcase_saved_state_for_feed_page', { error: error });
      return new Set<string>();
    } else {
      savedItems = postSavedItems as Array<{ post_id: string }> | null;
    }

    return new Set(
      (savedItems ?? [])
        .map((row) => row.post_id ?? row.generation_id)
        .filter((itemId): itemId is string => Boolean(itemId))
    );
  };

  const loadPurchasedBundleIds = async () => {
    if (remixEligibleBundleIds.length === 0) return new Set<string>();
    const { data: purchaseRows, error: purchaseError } = await adminSupabase
      .from('post_resource_bundle_purchases')
      .select('bundle_id')
      .eq('buyer_user_id', viewerUserId)
      .in('bundle_id', remixEligibleBundleIds);

    if (purchaseError) {
      logBackendError('error_fetching_post_resource_bundle_purchase_state_for_feed_page', { error: purchaseError });
      return new Set<string>();
    }

    return new Set(
      ((purchaseRows ?? []) as Array<{ bundle_id?: string | null }>)
        .map((row) => row.bundle_id)
        .filter((bundleId): bundleId is string => Boolean(bundleId))
    );
  };

  const [savedIdSet, purchasedBundleIdSet] = await Promise.all([
    loadSavedIds(),
    loadPurchasedBundleIds(),
  ]);

  return {
    ...feed,
    items: viewerSafeItems.map((item) => {
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

    logBackendError('error_fetching_showcase_post_detail', { error: result.error });
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
  const assets = Array.from(new Map(
    feed.items
      .map((item) => item.asset)
      .filter((asset): asset is NonNullable<ShowcaseFeedItem['asset']> => Boolean(asset))
      .map((asset) => [asset.id, asset] as const)
  ).values());

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

import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { cache } from 'react';

import {
  getMarketplaceAssetSummaryHydration,
  getPostMediaKind,
  isMissingPostReviewStatusColumnError,
  isMissingPostTextColumnsError,
  isMissingPostSourceToolSlugColumnError,
  isMissingPostsSchemaError,
  normalizeLegacyPostFormat,
} from '@/lib/posts-server';
import { getCreatorDisplayName, normalizeUsername } from '@/lib/profile';
import {
  getPostResourceBundlePriceQuote,
} from '@/lib/post-resource-bundles-server';
import { createServiceClient, resolveStoredMediaUrl } from '@/lib/server-helpers';
import {
  MAGICBOOKLET_SOURCE_KIND,
  sanitizeShowcaseFeedItem,
  type RawShowcaseSourceKind,
  type ShowcaseFeedItem,
  type ShowcaseItemCategory,
  type ShowcasePostFormat,
} from '@/lib/showcase';
import { resolvePostRowsToFeedItems, type PostRow } from '@/lib/showcase-feed';
import { slugifySourceTool } from '@/lib/source-tools';

interface LegacyCreatorGenerationRow {
  id: string;
  output_url: string | null;
  showcase_asset_path?: string | null;
  prompt: string | null;
  title: string | null;
  category: ShowcaseItemCategory | null;
  save_count: number | null;
  remix_count: number | null;
  created_at: string;
  model: string;
}

interface CreatorProfileRow {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
}

export interface CreatorProfilePageData {
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    coverUrl: string | null;
    websiteUrl: string | null;
    twitterHandle: string | null;
    instagramHandle: string | null;
    tiktokHandle: string | null;
    location: string | null;
  };
  stats: {
    publicCreations: number;
    totalSaves: number;
    totalRemixes: number;
    unlocks: number;
    totalUnlockSales: number;
    toolsUsed: Array<{ slug: string; label: string; count: number }>;
  };
  items: ShowcaseFeedItem[];
  pageInfo: {
    hasMore: boolean;
    nextLimit: number | null;
    nextOffset: number | null;
    limit: number;
    offset: number;
  };
}

const CREATOR_PAGE_SIZE = 24;
const CREATOR_PAGE_SIZE_MAX = 48;
const CREATOR_STATS_BATCH_SIZE = 500;
const CREATOR_ASSET_BATCH_SIZE = 100;

type CreatorServiceClient = ReturnType<typeof createServiceClient>;
type CreatorPostQueryMode = 'page' | 'stats';

const loadCreatorProfileRow = cache(async (username: string): Promise<CreatorProfileRow | null> => {
  const adminSupabase = createServiceClient();
  const { data, error } = await adminSupabase
    .from('profiles')
    .select('id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location')
    .eq('username', username)
    .maybeSingle();

  if (error) {
    logBackendError('failed_to_fetch_creator_profile', { error: error });
    throw error;
  }

  return data as unknown as CreatorProfileRow | null;
});

function resolveItemCategory(category: string | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad') return 'video';
  if (category === 'text') return 'text';
  return 'image';
}

async function attachLocalizedAssetPrices(
  assetMap: Map<string, NonNullable<ShowcaseFeedItem['asset']>>,
  countryCode?: string | null
) {
  if (assetMap.size === 0) return;

  await Promise.all(
    Array.from(assetMap.values()).map(async (asset) => {
      asset.priceQuote = await getPostResourceBundlePriceQuote(asset.priceUsdCents, countryCode);
    })
  );
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeCreatorPostRow(
  row: Record<string, unknown>,
  profileId: string,
  includeTextColumns: boolean
): PostRow {
  const category = (asNullableString(row.category) ?? 'image') as ShowcaseItemCategory;
  const postFormat: ShowcasePostFormat = includeTextColumns
    && (row.post_format === 'text' || row.post_format === 'media' || row.post_format === 'mixed')
    ? row.post_format
    : normalizeLegacyPostFormat(category);
  const sourceTool = asNullableString(row.source_tool);

  return {
    id: String(row.id),
    output_url: asNullableString(row.output_url),
    showcase_asset_path: asNullableString(row.showcase_asset_path),
    prompt: asNullableString(row.prompt),
    title: asNullableString(row.title),
    body: asNullableString(row.body),
    category,
    post_format: postFormat,
    save_count: typeof row.save_count === 'number' ? row.save_count : 0,
    remix_count: typeof row.remix_count === 'number' ? row.remix_count : 0,
    created_at: asNullableString(row.created_at) ?? new Date(0).toISOString(),
    user_id: profileId,
    generation_id: asNullableString(row.generation_id),
    source_kind: (asNullableString(row.source_kind) ?? 'external') as RawShowcaseSourceKind,
    source_tool: sourceTool,
    source_tool_slug: asNullableString(row.source_tool_slug) ?? slugifySourceTool(sourceTool),
    review_status: row.review_status === 'visible' || row.review_status === 'flagged' || row.review_status === 'hidden'
      ? row.review_status
      : null,
  };
}

async function fetchCreatorPostRows({
  adminSupabase,
  mode,
  offset,
  profileId,
  take,
}: {
  adminSupabase: CreatorServiceClient;
  mode: CreatorPostQueryMode;
  offset: number;
  profileId: string;
  take: number;
}): Promise<PostRow[] | null> {
  let includeSourceToolSlug = true;
  const includeReviewStatus = true;
  let includeTextColumns = mode === 'page';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const columns = mode === 'page'
      ? [
          'id',
          'output_url',
          'showcase_asset_path',
          'prompt',
          'title',
          includeTextColumns ? 'body' : null,
          'category',
          includeTextColumns ? 'post_format' : null,
          'save_count',
          'remix_count',
          'created_at',
          'generation_id',
          'source_kind',
          'source_tool',
          includeSourceToolSlug ? 'source_tool_slug' : null,
          includeReviewStatus ? 'review_status' : null,
        ]
      : [
          'id',
          'prompt',
          'category',
          'save_count',
          'remix_count',
          'created_at',
          'generation_id',
          'source_kind',
          'source_tool',
          includeSourceToolSlug ? 'source_tool_slug' : null,
          includeReviewStatus ? 'review_status' : null,
        ];

    let query = adminSupabase
      .from('posts')
      .select(columns.filter(Boolean).join(', '))
      .eq('user_id', profileId)
      .eq('visibility', 'public')
      .is('archived_at', null);

    if (includeReviewStatus) {
      query = query.eq('review_status', 'visible');
    }

    const result = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + Math.max(0, take - 1));

    if (!result.error) {
      return ((result.data ?? []) as unknown as Record<string, unknown>[]).map((row) =>
        normalizeCreatorPostRow(row, profileId, includeTextColumns)
      );
    }

    let shouldRetry = false;
    if (includeSourceToolSlug && isMissingPostSourceToolSlugColumnError(result.error)) {
      includeSourceToolSlug = false;
      shouldRetry = true;
    }
    if (includeReviewStatus && isMissingPostReviewStatusColumnError(result.error)) {
      // Public creator pages must not bypass moderation merely because a
      // deployment is missing the review status column.
      return [];
    }
    if (includeTextColumns && isMissingPostTextColumnsError(result.error)) {
      includeTextColumns = false;
      shouldRetry = true;
    }
    if (shouldRetry) continue;
    if (isMissingPostsSchemaError(result.error)) return null;

    logBackendError('failed_to_fetch_creator_posts', { error: result.error });
    throw result.error;
  }

  throw new Error('Failed to resolve the available creator post schema.');
}

async function loadAllCreatorPostMetricRows(
  adminSupabase: CreatorServiceClient,
  profileId: string
): Promise<PostRow[] | null> {
  const rows: PostRow[] = [];
  let offset = 0;

  while (true) {
    const batch = await fetchCreatorPostRows({
      adminSupabase,
      mode: 'stats',
      offset,
      profileId,
      take: CREATOR_STATS_BATCH_SIZE,
    });
    if (batch === null) return null;

    rows.push(...batch);
    if (batch.length < CREATOR_STATS_BATCH_SIZE) return rows;
    offset += batch.length;
  }
}

function normalizeLegacyGenerationRow(row: Record<string, unknown>): LegacyCreatorGenerationRow {
  return {
    id: String(row.id),
    output_url: asNullableString(row.output_url),
    showcase_asset_path: asNullableString(row.showcase_asset_path),
    prompt: asNullableString(row.prompt),
    title: asNullableString(row.title),
    category: asNullableString(row.category) as ShowcaseItemCategory | null,
    save_count: typeof row.save_count === 'number' ? row.save_count : 0,
    remix_count: typeof row.remix_count === 'number' ? row.remix_count : 0,
    created_at: asNullableString(row.created_at) ?? new Date(0).toISOString(),
    model: asNullableString(row.model) ?? MAGICBOOKLET_SOURCE_KIND,
  };
}

async function fetchLegacyGenerationRows({
  adminSupabase,
  mode,
  offset,
  profileId,
  take,
}: {
  adminSupabase: CreatorServiceClient;
  mode: CreatorPostQueryMode;
  offset: number;
  profileId: string;
  take: number;
}): Promise<LegacyCreatorGenerationRow[]> {
  const fullSelect = 'id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, model';
  const legacySelect = 'id, output_url, prompt, title, category, save_count, remix_count, created_at, model';
  const statsSelect = 'id, save_count, remix_count, created_at';
  const runQuery = (columns: string) => adminSupabase
    .from('generations')
    .select(columns)
    .eq('user_id', profileId)
    .eq('is_public', true)
    .eq('status', 'succeeded')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + Math.max(0, take - 1));

  let result = await runQuery(mode === 'page' ? fullSelect : statsSelect);
  if (mode === 'page' && result.error?.code === '42703') {
    result = await runQuery(legacySelect);
  }
  if (result.error) {
    logBackendError('failed_to_fetch_legacy_creator_generations', { error: result.error });
    throw result.error;
  }

  return ((result.data ?? []) as unknown as Record<string, unknown>[]).map(normalizeLegacyGenerationRow);
}

async function loadAllLegacyGenerationMetricRows(
  adminSupabase: CreatorServiceClient,
  profileId: string
): Promise<LegacyCreatorGenerationRow[]> {
  const rows: LegacyCreatorGenerationRow[] = [];
  let offset = 0;

  while (true) {
    const batch = await fetchLegacyGenerationRows({
      adminSupabase,
      mode: 'stats',
      offset,
      profileId,
      take: CREATOR_STATS_BATCH_SIZE,
    });
    rows.push(...batch);
    if (batch.length < CREATOR_STATS_BATCH_SIZE) return rows;
    offset += batch.length;
  }
}

async function loadCreatorAssetSummaries(rows: PostRow[], adminSupabase: CreatorServiceClient) {
  const assets = new Map<string, NonNullable<ShowcaseFeedItem['asset']>>();

  for (let index = 0; index < rows.length; index += CREATOR_ASSET_BATCH_SIZE) {
    const batch = rows.slice(index, index + CREATOR_ASSET_BATCH_SIZE);
    const { assetMap: marketplaceAssets } = await getMarketplaceAssetSummaryHydration(
      batch.map((row) => row.id),
      adminSupabase
    );
    for (const [postId, asset] of marketplaceAssets) assets.set(postId, asset);
  }

  return assets;
}

async function summarizeCreatorPosts(
  rows: PostRow[],
  adminSupabase: CreatorServiceClient
): Promise<CreatorProfilePageData['stats']> {
  const assets = await loadCreatorAssetSummaries(rows, adminSupabase);
  const toolCounts = new Map<string, { label: string; count: number }>();

  for (const row of rows) {
    const slug = row.source_tool_slug ?? slugifySourceTool(row.source_tool);
    if (!slug) continue;
    const existing = toolCounts.get(slug);
    toolCounts.set(slug, {
      label: existing?.label ?? row.source_tool ?? slug,
      count: (existing?.count ?? 0) + 1,
    });
  }

  return {
    publicCreations: rows.length,
    totalSaves: rows.reduce((sum, row) => sum + (row.save_count ?? 0), 0),
    totalRemixes: rows.reduce((sum, row) => sum + (row.remix_count ?? 0), 0),
    unlocks: assets.size,
    totalUnlockSales: Array.from(assets.values()).reduce((sum, asset) => sum + (asset.salesCount ?? 0), 0),
    toolsUsed: Array.from(toolCounts.entries())
      .map(([slug, value]) => ({ slug, ...value }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
  };
}

function isMissingCreatorStatsRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  return candidate.code === '42883'
    || candidate.code === 'PGRST202'
    || Boolean(candidate.message?.includes('get_creator_profile_stats'));
}

async function loadCreatorStats(
  adminSupabase: CreatorServiceClient,
  profileId: string
): Promise<CreatorProfilePageData['stats'] | null> {
  if (typeof (adminSupabase as unknown as { rpc?: unknown }).rpc !== 'function') return null;
  const { data, error } = await adminSupabase.rpc('get_creator_profile_stats', {
    p_creator_id: profileId,
  });
  if (error) {
    if (isMissingCreatorStatsRpcError(error)) return null;
    throw error;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const nonNegativeNumber = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const toolsUsed = Array.isArray(record.toolsUsed)
    ? record.toolsUsed.flatMap((tool): CreatorProfilePageData['stats']['toolsUsed'] => {
        if (!tool || typeof tool !== 'object') return [];
        const candidate = tool as Record<string, unknown>;
        if (typeof candidate.slug !== 'string' || typeof candidate.label !== 'string') return [];
        return [{
          slug: candidate.slug,
          label: candidate.label,
          count: nonNegativeNumber(candidate.count),
        }];
      })
    : [];

  return {
    publicCreations: nonNegativeNumber(record.publicCreations),
    totalSaves: nonNegativeNumber(record.totalSaves),
    totalRemixes: nonNegativeNumber(record.totalRemixes),
    unlocks: nonNegativeNumber(record.unlocks),
    totalUnlockSales: nonNegativeNumber(record.totalUnlockSales),
    toolsUsed,
  };
}

function creatorPageInfo({
  hasMore,
  limit,
  offset,
}: {
  hasMore: boolean;
  limit: number;
  offset: number;
}): CreatorProfilePageData['pageInfo'] {
  return {
    hasMore,
    limit,
    offset,
    nextOffset: hasMore ? offset + limit : null,
    nextLimit: hasMore ? Math.min(96, offset + limit + CREATOR_PAGE_SIZE) : null,
  };
}

function profileSummary(profile: CreatorProfileRow, fallbackUsername: string) {
  return {
    id: profile.id,
    username: profile.username ?? fallbackUsername,
    displayName: getCreatorDisplayName({
      displayName: profile.display_name,
      username: profile.username,
    }),
    bio: profile.bio,
    avatarUrl: profile.avatar_url,
    coverUrl: profile.cover_url,
    websiteUrl: profile.website_url,
    twitterHandle: profile.twitter_handle,
    instagramHandle: profile.instagram_handle,
    tiktokHandle: profile.tiktok_handle,
    location: profile.location,
  };
}

export const getCreatorProfileSummary = cache(async (rawUsername: string) => {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;
  const profile = await loadCreatorProfileRow(username);
  return profile ? profileSummary(profile, username) : null;
});

export const getCreatorProfilePageData = cache(async (
  rawUsername: string,
  options?: { limit?: number; offset?: number; countryCode?: string | null }
): Promise<CreatorProfilePageData | null> => {
  const username = normalizeUsername(rawUsername);
  if (!username) return null;

  const requestedLimit = Number.isFinite(options?.limit)
    ? Math.round(options?.limit ?? CREATOR_PAGE_SIZE)
    : CREATOR_PAGE_SIZE;
  const requestedOffset = Number.isFinite(options?.offset) ? Math.round(options?.offset ?? 0) : 0;
  const limit = Math.min(CREATOR_PAGE_SIZE_MAX, Math.max(1, requestedLimit));
  const offset = Math.max(0, requestedOffset);

  const profile = await loadCreatorProfileRow(username);
  if (!profile) return null;

  const adminSupabase = createServiceClient();

  const [pageRows, aggregateStats] = await Promise.all([
    fetchCreatorPostRows({
      adminSupabase,
      mode: 'page',
      offset,
      profileId: profile.id,
      take: limit + 1,
    }),
    loadCreatorStats(adminSupabase, profile.id),
  ]);

  if (pageRows === null) {
    const [legacyPageRows, legacyMetricRows] = await Promise.all([
      fetchLegacyGenerationRows({
        adminSupabase,
        mode: 'page',
        offset,
        profileId: profile.id,
        take: limit + 1,
      }),
      loadAllLegacyGenerationMetricRows(adminSupabase, profile.id),
    ]);
    const hasMore = legacyPageRows.length > limit;
    const resolvedLegacyItems = await Promise.all<ShowcaseFeedItem | null>(
      legacyPageRows.slice(0, limit).map(async (generation) => {
        const mediaUrl = generation.showcase_asset_path
          ? adminSupabase.storage.from('showcase_media').getPublicUrl(generation.showcase_asset_path).data.publicUrl
          : generation.output_url
            ? await resolveStoredMediaUrl(adminSupabase, generation.output_url)
            : null;
        if (!mediaUrl) return null;

        const category = resolveItemCategory(generation.category);
        return {
          id: generation.id,
          mediaUrl,
          mediaKind: getPostMediaKind(category, 'media'),
          model: generation.model,
          title: generation.title || 'Untitled Creation',
          prompt: generation.prompt || '',
          body: '',
          category,
          postFormat: 'media',
          saveCount: generation.save_count || 0,
          remixCount: generation.remix_count || 0,
          commentCount: 0,
          createdAt: generation.created_at,
          creator: {
            id: profile.id,
            username: profile.username,
            name: getCreatorDisplayName({
              displayName: profile.display_name,
              username: profile.username,
            }),
            avatar: profile.avatar_url,
          },
          sourceKind: MAGICBOOKLET_SOURCE_KIND,
          sourceTool: null,
          sourceToolSlug: 'magicbooklet',
          generationId: generation.id,
          asset: null,
          canRemix: true,
        } satisfies ShowcaseFeedItem;
      })
    );

    return {
      profile: profileSummary(profile, username),
      stats: {
        publicCreations: legacyMetricRows.length,
        totalSaves: legacyMetricRows.reduce((sum, item) => sum + (item.save_count ?? 0), 0),
        totalRemixes: legacyMetricRows.reduce((sum, item) => sum + (item.remix_count ?? 0), 0),
        unlocks: 0,
        totalUnlockSales: 0,
        toolsUsed: [],
      },
      items: resolvedLegacyItems.filter((item): item is ShowcaseFeedItem => item !== null),
      pageInfo: creatorPageInfo({ hasMore, limit, offset }),
    };
  }

  const hasMore = pageRows.length > limit;
  const visibleRows = pageRows.slice(0, limit);
  // A creator profile is a public surface, so it owes viewers the same
  // redaction the showcase feed applies: locked bundle metadata (real filenames,
  // item titles, sizes) and paid recipe text never leave the server.
  // A creator profile is a public surface, so it owes viewers the same
  // redaction the showcase feed applies: locked bundle metadata (real filenames,
  // item titles, sizes) and paid recipe text never leave the server.
  const items = (await resolvePostRowsToFeedItems(visibleRows, adminSupabase))
    .map(sanitizeShowcaseFeedItem);
  const stats = aggregateStats ?? await summarizeCreatorPosts(
    await loadAllCreatorPostMetricRows(adminSupabase, profile.id) ?? visibleRows,
    adminSupabase
  );

  const localizedAssets = new Map<string, NonNullable<ShowcaseFeedItem['asset']>>();
  for (const item of items) {
    if (item.asset) localizedAssets.set(item.id, item.asset);
  }
  await attachLocalizedAssetPrices(localizedAssets, options?.countryCode);

  return {
    profile: profileSummary(profile, username),
    stats,
    items,
    pageInfo: creatorPageInfo({ hasMore, limit, offset }),
  };
});

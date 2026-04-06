import 'server-only';

import { unstable_cache } from 'next/cache';

import { getCreatorDisplayName } from '@/lib/profile';
import {
  canRemixPost,
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
  type ShowcaseCategory,
  type ShowcaseFeedItem,
  type ShowcaseFeedPage,
  type ShowcaseItemCategory,
  type ShowcasePostFormat,
  type ShowcaseSort,
} from '@/lib/showcase';

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
  source_kind: 'ugc_copy' | 'external' | 'manual';
  source_tool: string | null;
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
  source_kind: 'ugc_copy' | 'external';
  source_tool: string | null;
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

function resolveItemCategory(category: ShowcaseItemCategory | null): ShowcaseItemCategory {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }

  return 'image';
}

function applyPostSort<T extends { created_at: string; id: string; save_count?: number | null; remix_count?: number | null }>(
  rows: T[],
  sort: ShowcaseSort
) {
  return [...rows].sort((left, right) => {
    if (sort === 'top-saves') {
      return (right.save_count ?? 0) - (left.save_count ?? 0) || right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
    }

    if (sort === 'top-remixes') {
      return (right.remix_count ?? 0) - (left.remix_count ?? 0) || right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
    }

    return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
  });
}

async function fetchPostRows(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number
): Promise<PostRow[] | null> {
  const adminSupabase = createServiceClient();
  let query = adminSupabase
    .from('posts')
    .select('id, output_url, showcase_asset_path, prompt, title, body, category, post_format, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
    .eq('visibility', 'public');

  if (category === 'text') {
    query = query.or('category.eq.text,post_format.eq.mixed');
  } else if (category !== 'all') {
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

  let result = await query.range(offset, offset + limit);

  if (isMissingPostTextColumnsError(result.error)) {
    if (category === 'text') {
      return [];
    }

    let legacyQuery = adminSupabase
      .from('posts')
      .select('id, output_url, showcase_asset_path, prompt, title, category, save_count, remix_count, created_at, user_id, source_kind, source_tool, generation_id')
      .eq('visibility', 'public');

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

    const legacyResult = await legacyQuery.range(offset, offset + limit);
    if (legacyResult.error) {
      console.error('Error fetching showcase feed:', legacyResult.error);
      throw legacyResult.error;
    }

    return ((legacyResult.data ?? []) as LegacyPostRow[]).map((row) => ({
      ...row,
      body: null,
      post_format: normalizeLegacyPostFormat(row.category),
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

async function getShowcaseFeedPageBase(
  category: ShowcaseCategory,
  sort: ShowcaseSort,
  offset: number,
  limit: number
): Promise<ShowcaseFeedPage> {
  const adminSupabase = createServiceClient();
  const posts = await fetchPostRows(category, sort, offset, limit);
  if (posts === null) {
    return getLegacyShowcaseFeedPageBase(category, sort, offset, limit);
  }

  const hasMore = posts.length > limit;
  const visibleRows = hasMore ? posts.slice(0, limit) : posts;
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

  const resolvedItems = await Promise.all(
    visibleRows.map(async (post): Promise<ShowcaseFeedItem | null> => {
      const mediaUrl = await resolvePostMediaUrl(adminSupabase, post);
      if (post.post_format !== 'text' && !mediaUrl) {
        return null;
      }

      const profile = post.user_id ? profilesMap[post.user_id] : undefined;
      const body = post.body?.trim() || '';
      const model = post.generation_id
        ? generationModelMap.get(post.generation_id) ?? 'ugc_copy'
        : post.source_kind === 'manual'
          ? 'manual'
          : post.source_tool ?? 'external';

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
        sourceKind: post.source_kind,
        sourceTool: post.source_tool,
        generationId: post.generation_id,
        asset: assetMap.get(post.id) ?? null,
        canRemix: canRemixPost(post.generation_id),
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
          sourceKind: 'ugc_copy',
          sourceTool: null,
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
  limit: number
): Promise<ShowcaseFeedPage> {
  try {
    return await getCachedShowcaseFeedPageBase(category, sort, offset, limit);
  } catch (error) {
    if (isMissingIncrementalCacheError(error)) {
      return getShowcaseFeedPageBase(category, sort, offset, limit);
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
}): Promise<ShowcaseFeedPage> {
  const { category, sort, offset, limit } = options;
  const adminSupabase = createServiceClient();
  const viewerUserId = options.viewerUserId ?? null;
  const baseFeed = await loadShowcaseFeedPageBase(category, sort, offset, limit);

  if (!viewerUserId || baseFeed.items.length === 0) {
    return baseFeed;
  }

  let savedItems: Array<{ post_id?: string; generation_id?: string }> | null = null;
  const { data: postSavedItems, error } = await adminSupabase
    .from('post_saves')
    .select('post_id')
    .eq('user_id', viewerUserId)
    .in('post_id', baseFeed.items.map((item) => item.id));

  if (error && isMissingPostsSchemaError(error)) {
    const legacySavedResult = await adminSupabase
      .from('showcase_saves')
      .select('generation_id')
      .eq('user_id', viewerUserId)
      .in('generation_id', baseFeed.items.map((item) => item.generationId ?? item.id));

    if (legacySavedResult.error) {
      console.error('Error fetching legacy showcase saved state for feed page:', legacySavedResult.error);
      return baseFeed;
    }

    savedItems = legacySavedResult.data as Array<{ generation_id: string }> | null;
  } else if (error) {
    console.error('Error fetching showcase saved state for feed page:', error);
    return baseFeed;
  } else {
    savedItems = postSavedItems as Array<{ post_id: string }> | null;
  }

  const savedIdSet = new Set(
    (savedItems ?? []).map((row) => row.post_id ?? row.generation_id).filter(Boolean)
  );

  return {
    ...baseFeed,
    items: baseFeed.items.map((item) => ({
      ...item,
      isSaved: savedIdSet.has(item.id) || (item.generationId ? savedIdSet.has(item.generationId) : false),
    })),
  };
}

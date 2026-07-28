import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  type ImmersivePreviewItem,
  type PreviewViewerSource,
} from '@/lib/immersive-preview-view-model';
import { flattenCreatorProfilePages } from '@/lib/creator-profile-view-model';
import {
  createShowcaseFeedViewerQueryKey,
  flattenShowcaseFeedPages,
  getShowcaseFeedSessionContext,
} from '@/lib/showcase-feed-query';
import type {
  GenerationListItem,
  GenerationListResponse,
  CreatorProfileResponse,
  OwnerPostsResponse,
  ProfileResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';

type QueryValue = string | number | boolean | null | undefined;

export const VIEWER_SOURCES: PreviewViewerSource[] = [
  'showcase-feed',
  'creator-profile',
  'home-community',
  'profile-saved',
  'profile-posts',
  'profile-creations',
  'studio-creations',
  'home-creations',
];

export type ImmersiveSourceData = {
  showcaseItems?: ShowcaseFeedItem[];
  generations?: GenerationListItem[];
  ownerPosts?: OwnerPostsResponse['posts'];
  feedSessionId?: string | null;
  algorithmVersion?: string | null;
};

export interface ImmersivePreviewApi {
  getShowcaseFeed: (
    params?: Record<string, QueryValue>,
    options?: { auth?: boolean }
  ) => Promise<ShowcaseFeedResponse>;
  getCreatorProfile: (username: string, params?: Record<string, QueryValue>) => Promise<CreatorProfileResponse>;
  getSavedMedia: (params?: Record<string, QueryValue>) => Promise<ShowcaseFeedResponse>;
  getShowcasePost: (postId: string) => Promise<ShowcasePostResponse>;
  listGenerations: (
    includeCompleted?: boolean,
    options?: { limit?: number }
  ) => Promise<GenerationListResponse>;
  listOwnerPosts: (params?: Record<string, QueryValue>) => Promise<OwnerPostsResponse>;
}

export function normalizeViewerSource(value: string | string[] | undefined): PreviewViewerSource {
  const source = normalizeParam(value);
  return VIEWER_SOURCES.includes(source as PreviewViewerSource) ? source as PreviewViewerSource : 'showcase-feed';
}

export function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function buildViewerItems(
  source: PreviewViewerSource,
  data: ImmersiveSourceData | undefined,
  owner: { creatorLabel: string; creatorAvatar?: string | null; creatorId?: string | null }
): ImmersivePreviewItem[] {
  if (isGenerationSource(source)) {
    return buildImmersiveGenerationItems(source, data?.generations ?? [], owner, data?.ownerPosts ?? []);
  }
  if (source === 'profile-posts') {
    return buildImmersiveOwnerPostItems(source, data?.ownerPosts ?? [], owner);
  }
  return buildImmersiveShowcaseItems(source, data?.showcaseItems ?? []);
}

export function isGenerationSource(source: PreviewViewerSource) {
  return source === 'profile-creations' || source === 'studio-creations' || source === 'home-creations';
}

export async function loadImmersiveSourceData({
  api,
  source,
  initialId,
  creatorUsername,
}: {
  api: ImmersivePreviewApi;
  source: PreviewViewerSource;
  initialId: string;
  creatorUsername?: string | null;
}): Promise<ImmersiveSourceData> {
  if (isGenerationSource(source)) {
    const [generationResponse, ownerPostResponse] = await Promise.all([
      api.listGenerations(true, { limit: 48 }),
      api.listOwnerPosts({ includeArchived: true, limit: 48, visibility: 'all' }),
    ]);
    return {
      generations: generationResponse.generations,
      ownerPosts: ownerPostResponse.posts,
    };
  }

  if (source === 'profile-posts') {
    const response = await api.listOwnerPosts({ includeArchived: true, limit: 48, visibility: 'all' });
    return { ownerPosts: response.posts };
  }

  if (source === 'profile-saved') {
    const response = await api.getSavedMedia({ limit: 48 });
    let showcaseItems = response.items;

    if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
      const detail = await api.getShowcasePost(initialId).catch(() => null);
      if (detail?.item) {
        showcaseItems = [detail.item, ...showcaseItems];
      }
    }

    return { showcaseItems };
  }

  if (source === 'creator-profile') {
    if (creatorUsername) {
      const response = await api.getCreatorProfile(creatorUsername, { limit: 48 });
      let showcaseItems = response.items;

      if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
        const detail = await api.getShowcasePost(initialId).catch(() => null);
        if (detail?.item) {
          showcaseItems = [detail.item, ...showcaseItems];
        }
      }

      return { showcaseItems };
    }

    const detail = initialId ? await api.getShowcasePost(initialId).catch(() => null) : null;
    return { showcaseItems: detail?.item ? [detail.item] : [] };
  }

  const response = await api.getShowcaseFeed({ limit: 48, sort: 'for-you' });
  let showcaseItems = response.items;

  if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
    const detail = await api.getShowcasePost(initialId).catch(() => null);
    if (detail?.item) {
      showcaseItems = [detail.item, ...showcaseItems];
    }
  }

  return {
    showcaseItems,
    feedSessionId: response.feedSessionId ?? null,
    algorithmVersion: response.algorithmVersion ?? null,
  };
}

export function readCachedImmersiveSourceData(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  initialId: string,
  feedSessionId?: string | null
): ImmersiveSourceData | undefined {
  if (isGenerationSource(source)) {
    const data = {
      ...(cachedGenerations(queryClient, userId) ?? {}),
      ...(cachedOwnerPosts(queryClient, userId) ?? {}),
    };
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  if (source === 'profile-posts') {
    const data = cachedOwnerPosts(queryClient, userId);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  if (source === 'creator-profile') {
    const data = cachedCreatorProfileItems(queryClient);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  const data = cachedShowcaseItems(queryClient, source, userId, initialId, feedSessionId);
  return sourceDataContains(data, initialId) ? data : undefined;
}

export function readCachedProfile(queryClient: QueryClient, userId: string | undefined): ProfileResponse | undefined {
  return queryClient.getQueryData<ProfileResponse>(['profile', userId]);
}

function cachedShowcaseItems(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  initialId: string,
  feedSessionId?: string | null
): ImmersiveSourceData | undefined {
  if (source === 'profile-saved') {
    const saved = queryClient.getQueryData<CachedPages<ShowcaseFeedResponse>>(['profile-saved-media', userId]);
    const showcaseItems = readCachedPages(saved)
      .flatMap((page) => page.items)
      .filter((item) => item.isSaved);
    return showcaseItems.length ? { showcaseItems } : undefined;
  }

  const feedQueries = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
    queryKey: createShowcaseFeedViewerQueryKey(userId),
  });
  const rankedSources = feedQueries
    .map(([, data]) => data)
    .filter((data): data is InfiniteData<ShowcaseFeedResponse> => Boolean(data?.pages.length));
  const selected = rankedSources.find((data) => Boolean(
    feedSessionId && data.pages.some((page) => page.feedSessionId === feedSessionId)
  )) ?? rankedSources.find((data) => flattenShowcaseFeedPages(data.pages).some((item) => item.id === initialId));

  if (selected) {
    const showcaseItems = flattenShowcaseFeedPages(selected.pages);
    const context = getShowcaseFeedSessionContext(selected.pages);
    return showcaseItems.length ? {
      showcaseItems,
      feedSessionId: context.feedSessionId,
      algorithmVersion: context.algorithmVersion,
    } : undefined;
  }

  const saved = queryClient.getQueryData<CachedPages<ShowcaseFeedResponse>>(['profile-saved-media', userId]);
  const showcaseItems = dedupeById(readCachedPages(saved).flatMap((page) => page.items));
  return showcaseItems.length ? { showcaseItems } : undefined;
}

function cachedCreatorProfileItems(queryClient: QueryClient): ImmersiveSourceData | undefined {
  const items: ShowcaseFeedItem[] = [];
  const creatorQueries = queryClient.getQueriesData<CreatorProfileResponse | InfiniteData<CreatorProfileResponse>>({ queryKey: ['creator-profile'] });

  for (const [, data] of creatorQueries) {
    if (data && 'pages' in data) {
      items.push(...flattenCreatorProfilePages(data.pages));
    } else if (data?.items.length) {
      items.push(...data.items);
    }
  }

  const showcaseItems = dedupeById(items);
  return showcaseItems.length ? { showcaseItems } : undefined;
}

function cachedGenerations(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: GenerationListItem[] = [];
  // `profile-generations` is paginated; `home-generations` and `generations` stay single-page.
  for (const key of [['profile-generations', userId], ['home-generations', userId], ['generations', userId]] as const) {
    const data = queryClient.getQueryData<CachedPages<GenerationListResponse>>(key);
    all.push(...readCachedPages(data).flatMap((page) => page.generations ?? []));
  }
  const generations = dedupeById(all);
  return generations.length ? { generations } : undefined;
}

function cachedOwnerPosts(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: OwnerPostsResponse['posts'] = [];
  // `profile-owner-posts` is paginated; `owner-posts-sales-summary` stays single-page.
  for (const key of [['profile-owner-posts', userId], ['owner-posts-sales-summary', userId]] as const) {
    const data = queryClient.getQueryData<CachedPages<OwnerPostsResponse>>(key);
    all.push(...readCachedPages(data).flatMap((page) => page.posts ?? []));
  }
  const ownerPosts = dedupeById(all);
  return ownerPosts.length ? { ownerPosts } : undefined;
}

type CachedPages<T> = T | InfiniteData<T>;

/** Reads a cache entry that may hold a single response or a paginated one. */
function readCachedPages<T>(data: CachedPages<T> | undefined): T[] {
  if (!data) return [];
  return 'pages' in (data as object) ? (data as InfiniteData<T>).pages : [data as T];
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

function sourceDataContains(data: ImmersiveSourceData | undefined, initialId: string) {
  if (!data || !initialId) return false;
  return Boolean(
    data.showcaseItems?.some((item) => item.id === initialId)
    || data.generations?.some((item) => item.id === initialId)
    || data.ownerPosts?.some((item) => item.id === initialId)
  );
}

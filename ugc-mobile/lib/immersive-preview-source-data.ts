import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  type ImmersivePreviewItem,
  type PreviewViewerSource,
} from '@/lib/immersive-preview-view-model';
import { flattenShowcaseFeedPages } from '@/lib/showcase-feed-query';
import type {
  GenerationListItem,
  OwnerPostsResponse,
  ProfileResponse,
  ShowcaseFeedItem,
  ShowcaseFeedResponse,
  ShowcasePostResponse,
} from '@/lib/types';

type QueryValue = string | number | boolean | null | undefined;

export const VIEWER_SOURCES: PreviewViewerSource[] = [
  'showcase-feed',
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
};

export interface ImmersivePreviewApi {
  getShowcaseFeed: (
    params?: Record<string, QueryValue>,
    options?: { auth?: boolean }
  ) => Promise<ShowcaseFeedResponse>;
  getShowcasePost: (postId: string) => Promise<ShowcasePostResponse>;
  listGenerations: (includeCompleted?: boolean) => Promise<{ generations: GenerationListItem[] }>;
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
  owner: { creatorLabel: string; creatorAvatar?: string | null }
): ImmersivePreviewItem[] {
  if (isGenerationSource(source)) {
    return buildImmersiveGenerationItems(source, data?.generations ?? [], owner);
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
}: {
  api: ImmersivePreviewApi;
  source: PreviewViewerSource;
  initialId: string;
}): Promise<ImmersiveSourceData> {
  if (isGenerationSource(source)) {
    const response = await api.listGenerations(true);
    return { generations: response.generations };
  }

  if (source === 'profile-posts') {
    const response = await api.listOwnerPosts({ includeArchived: true, visibility: 'all' });
    return { ownerPosts: response.posts };
  }

  const response = await api.getShowcaseFeed({ limit: 48, sort: 'recent' }, { auth: source === 'profile-saved' });
  let showcaseItems = source === 'profile-saved'
    ? response.items.filter((item) => item.isSaved || item.id === initialId)
    : response.items;

  if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
    const detail = await api.getShowcasePost(initialId).catch(() => null);
    if (detail?.item) {
      showcaseItems = [detail.item, ...showcaseItems];
    }
  }

  return { showcaseItems };
}

export function readCachedImmersiveSourceData(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  initialId: string
): ImmersiveSourceData | undefined {
  if (isGenerationSource(source)) {
    const data = cachedGenerations(queryClient, userId);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  if (source === 'profile-posts') {
    const data = cachedOwnerPosts(queryClient, userId);
    return sourceDataContains(data, initialId) ? data : undefined;
  }

  const data = cachedShowcaseItems(queryClient, source, userId);
  return sourceDataContains(data, initialId) ? data : undefined;
}

export function readCachedProfile(queryClient: QueryClient, userId: string | undefined): ProfileResponse | undefined {
  return queryClient.getQueryData<ProfileResponse>(['profile', userId])
    ?? queryClient.getQueryData<ProfileResponse>(['home-profile', userId]);
}

function cachedShowcaseItems(queryClient: QueryClient, source: PreviewViewerSource, userId: string | undefined): ImmersiveSourceData | undefined {
  const items: ShowcaseFeedItem[] = [];
  const saved = queryClient.getQueryData<ShowcaseFeedResponse>(['profile-saved-showcase', userId]);
  if (saved?.items.length) {
    items.push(...saved.items);
  }

  const feedQueries = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({ queryKey: ['showcase-feed'] });
  for (const [, data] of feedQueries) {
    items.push(...flattenShowcaseFeedPages(data?.pages));
  }

  const deduped = dedupeById(items);
  const showcaseItems = source === 'profile-saved' ? deduped.filter((item) => item.isSaved) : deduped;
  return showcaseItems.length ? { showcaseItems } : undefined;
}

function cachedGenerations(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: GenerationListItem[] = [];
  for (const key of [['profile-generations', userId], ['home-generations', userId], ['generations', userId]] as const) {
    const data = queryClient.getQueryData<{ generations: GenerationListItem[] }>(key);
    if (data?.generations.length) all.push(...data.generations);
  }
  const generations = dedupeById(all);
  return generations.length ? { generations } : undefined;
}

function cachedOwnerPosts(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceData | undefined {
  const all: OwnerPostsResponse['posts'] = [];
  for (const key of [['profile-owner-posts', userId], ['home-seller-posts', userId]] as const) {
    const data = queryClient.getQueryData<OwnerPostsResponse>(key);
    if (data?.posts.length) all.push(...data.posts);
  }
  const ownerPosts = dedupeById(all);
  return ownerPosts.length ? { ownerPosts } : undefined;
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

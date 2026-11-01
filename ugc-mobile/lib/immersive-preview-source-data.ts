import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';

import { selectCreationLibraryItems } from '@/lib/creation-library';
import { dedupeInFlight } from '@/lib/in-flight';
import { profileFailedGenerationsQueryKey } from '@/lib/profile-media-query';
import {
  buildImmersiveGenerationItems,
  buildImmersiveOwnerPostItems,
  buildImmersiveShowcaseItems,
  type ImmersivePreviewItem,
  type PreviewViewerSource,
} from '@/lib/immersive-preview-view-model';
import {
  createShowcaseFeedViewerQueryKey,
  flattenShowcaseFeedPages,
  getShowcaseFeedSessionContext,
  SHOWCASE_FEED_PAGE_SIZE,
} from '@/lib/showcase-feed-query';
import type {
  GenerationListItem,
  GenerationListResponse,
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

/** How many recent creations a generation-sourced viewer loads around the one it opens. */
export const IMMERSIVE_GENERATION_WINDOW = 48;

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
  getSavedMedia: (params?: Record<string, QueryValue>) => Promise<ShowcaseFeedResponse>;
  getShowcasePost: (postId: string) => Promise<ShowcasePostResponse>;
  /** The first argument is `includeArchived`, as in the API client itself. */
  listGenerations: (
    includeArchived?: boolean,
    options?: { limit?: number; id?: string }
  ) => Promise<GenerationListResponse>;
  listOwnerPosts: (params?: Record<string, QueryValue>) => Promise<OwnerPostsResponse>;
  getOwnerPost: (postId: string) => Promise<{ success: boolean; post: OwnerPostsResponse['posts'][number] }>;
}

export function normalizeViewerSource(value: string | string[] | undefined): PreviewViewerSource {
  const source = normalizeParam(value);
  return VIEWER_SOURCES.includes(source as PreviewViewerSource) ? source as PreviewViewerSource : 'showcase-feed';
}

export function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/**
 * The items a viewer shows for its source.
 *
 * Generation sources hold the creations the grid does — the shared library rule
 * in `creation-library`, not "has media". Keeping only items with media dropped
 * the grid's own "File no longer available" tile, so tapping it opened the first
 * creation instead; and archived runs the grid never showed came in with the
 * viewer's wider request (audit C1, C3). The item a route named on purpose stays
 * whatever its state: a "your video failed" notification lands on that run and
 * explains itself.
 */
export function buildViewerItems(
  source: PreviewViewerSource,
  data: ImmersiveSourceData | undefined,
  owner: { creatorLabel: string; creatorAvatar?: string | null; creatorId?: string | null },
  initialId?: string | null
): ImmersivePreviewItem[] {
  if (isGenerationSource(source)) {
    return buildImmersiveGenerationItems(
      source,
      selectCreationLibraryItems(data?.generations ?? [], initialId),
      owner,
      data?.ownerPosts ?? []
    );
  }
  if (source === 'profile-posts') {
    return buildImmersiveOwnerPostItems(source, data?.ownerPosts ?? [], owner);
  }
  return buildImmersiveShowcaseItems(source, data?.showcaseItems ?? [], owner.creatorId ?? null);
}

export function isGenerationSource(source: PreviewViewerSource) {
  return source === 'profile-creations' || source === 'studio-creations' || source === 'home-creations';
}

/**
 * A post read by its id, or null when there is no such post to show: deleted,
 * made private, or hidden from this reader. Any other failure is thrown, so a
 * dropped connection reads as "Couldn't load" with a way to try again, not as
 * a post that is gone.
 */
export async function readShowcasePostOrMissing(
  api: Pick<ImmersivePreviewApi, 'getShowcasePost'>,
  postId: string
): Promise<ShowcaseFeedItem | null> {
  try {
    const response = await api.getShowcasePost(postId);
    return response.item ?? null;
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function loadImmersiveSourceData({
  api,
  source,
  initialId,
  mediaOnly = false,
}: {
  api: ImmersivePreviewApi;
  source: PreviewViewerSource;
  initialId: string;
  mediaOnly?: boolean;
}): Promise<ImmersiveSourceData> {
  if (isGenerationSource(source)) {
    // The library window is unarchived, as the grid's is. Owner posts are not
    // part of this read: linked-post details are enrichment loaded beside it, so
    // a failing or slow post list can no longer discard or hold back creations
    // that loaded (audit C5). Concurrent opens share the one request.
    const response = await dedupeInFlight(
      api,
      `generations:library:${IMMERSIVE_GENERATION_WINDOW}`,
      () => api.listGenerations(false, { limit: IMMERSIVE_GENERATION_WINDOW })
    );
    let generations = response.generations;
    if (initialId && !generations.some((item) => item.id === initialId)) {
      // A deliberate route can name a creation outside the window: an older
      // tile, an archived creation, a notification for an unfinished run. One
      // owner-scoped lookup refreshes its signed media without loading the
      // whole library.
      const detail = await api.listGenerations(true, { id: initialId, limit: 1 });
      const selected = detail.generations.find((item) => item.id === initialId);
      if (selected) generations = [selected, ...generations];
    }
    return { generations };
  }

  if (source === 'profile-posts') {
    const response = await api.listOwnerPosts({ includeArchived: true, limit: 48, visibility: 'all' });
    let ownerPosts = response.posts;
    if (initialId && !ownerPosts.some((item) => item.id === initialId)) {
      const detail = await api.getOwnerPost(initialId);
      if (detail.success && detail.post.id === initialId) ownerPosts = [detail.post, ...ownerPosts];
    }
    return { ownerPosts };
  }

  if (source === 'profile-saved') {
    const response = await api.getSavedMedia({ limit: 48 });
    let showcaseItems = response.items;

    if (initialId && !showcaseItems.some((item) => item.id === initialId)) {
      const selected = await readShowcasePostOrMissing(api, initialId);
      if (selected) {
        showcaseItems = [selected, ...showcaseItems];
      }
    }

    return { showcaseItems };
  }

  if (source === 'creator-profile') {
    // A reel opened on a creator's page reads and pages that page's own grid
    // (`use-creator-reel-source`); it used to load a 48-post window of its own
    // here, which stopped where the grid could have gone on (audit 02-6). A
    // link that names no creator has no grid to read: the post on its own.
    const selected = initialId ? await readShowcasePostOrMissing(api, initialId) : null;
    return { showcaseItems: selected ? [selected] : [] };
  }

  // A cold link or notification opens a post that is rarely in the first
  // page of For You, so the post is read beside the feed rather than after
  // it: one round trip instead of two before anything shows. A reel opened
  // from a grid reads the grid's own lane instead (`use-showcase-lane-source`).
  // One page, as a lane asks for: every post the page holds is served to this
  // reader, and posts served and never reached count against them in the
  // ranking (audit 04-10; 48 was clamped to 24 by the route).
  const [response, selected] = await Promise.all([
    api.getShowcaseFeed({ limit: SHOWCASE_FEED_PAGE_SIZE, sort: 'for-you', ...(mediaOnly ? { category: 'media' } : {}) }),
    initialId ? readShowcasePostOrMissing(api, initialId) : Promise.resolve(null),
  ]);
  let showcaseItems = response.items;

  if (initialId && selected && !showcaseItems.some((item) => item.id === initialId)) {
    showcaseItems = [selected, ...showcaseItems];
  }

  return {
    showcaseItems,
    feedSessionId: response.feedSessionId ?? null,
    algorithmVersion: response.algorithmVersion ?? null,
  };
}

/**
 * Cached data a viewer can open on before its own request returns, with the age
 * of the caches it came from.
 *
 * The age matters as much as the data. Handed over as bare `initialData`, an
 * hour-old grid page became "fresh" for another 45 seconds in the viewer, so
 * nothing refetched it (audit C4). `updatedAt` is the oldest contributing
 * cache's: a snapshot is only as fresh as its stalest part. Pass it as the
 * query's `initialDataUpdatedAt`.
 */
export type ImmersiveSourceSnapshot = {
  data: ImmersiveSourceData;
  updatedAt: number;
};

/**
 * `userId` is the registered account, whose own libraries and saved posts are
 * keyed by it. `identityUserId` is the backend identity, guest or registered
 * (`identityUserId` from `useAuth`), which the feed lanes are keyed by: a
 * showcase reel can open on the lane that holds its post. A caller that reads
 * only an account's libraries can leave it out.
 *
 * A creator's reel has no snapshot here: one opened on their page reads the
 * page's grid itself (`use-creator-reel-source`), and no other cache holds
 * their posts in their order.
 */
export function readCachedImmersiveSourceSnapshot(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  initialId: string,
  feedSessionId?: string | null,
  identityUserId?: string | null
): ImmersiveSourceSnapshot | undefined {
  if (source === 'creator-profile') return undefined;
  const snapshot = isGenerationSource(source)
    ? cachedGenerations(queryClient, userId)
    : source === 'profile-posts'
      ? cachedOwnerPosts(queryClient, userId)
      : cachedShowcaseItems(queryClient, source, userId, identityUserId, initialId, feedSessionId);
  return snapshot && sourceDataContains(snapshot.data, initialId) ? snapshot : undefined;
}

export function readCachedImmersiveSourceData(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  initialId: string,
  feedSessionId?: string | null,
  identityUserId?: string | null
): ImmersiveSourceData | undefined {
  return readCachedImmersiveSourceSnapshot(
    queryClient,
    source,
    userId,
    initialId,
    feedSessionId,
    identityUserId
  )?.data;
}

export function readCachedProfile(queryClient: QueryClient, userId: string | undefined): ProfileResponse | undefined {
  return queryClient.getQueryData<ProfileResponse>(['profile', userId]);
}

function cachedShowcaseItems(
  queryClient: QueryClient,
  source: PreviewViewerSource,
  userId: string | undefined,
  identityUserId: string | null | undefined,
  initialId: string,
  feedSessionId?: string | null
): ImmersiveSourceSnapshot | undefined {
  const savedKey: QueryKey = ['profile-saved-media', userId];

  if (source === 'profile-saved') {
    const saved = queryClient.getQueryData<CachedPages<ShowcaseFeedResponse>>(savedKey);
    const showcaseItems = readCachedPages(saved)
      .flatMap((page) => page.items)
      .filter((item) => item.isSaved);
    return showcaseItems.length
      ? { data: { showcaseItems }, updatedAt: oldestUpdatedAt(queryClient, [savedKey]) }
      : undefined;
  }

  const feedQueries = queryClient.getQueriesData<InfiniteData<ShowcaseFeedResponse>>({
    queryKey: createShowcaseFeedViewerQueryKey(identityUserId),
  });
  const rankedSources = feedQueries
    .filter((entry): entry is [QueryKey, InfiniteData<ShowcaseFeedResponse>] => Boolean(entry[1]?.pages.length));
  const selected = rankedSources.find(([, data]) => Boolean(
    feedSessionId && data.pages.some((page) => page.feedSessionId === feedSessionId)
  )) ?? rankedSources.find(([, data]) => flattenShowcaseFeedPages(data.pages).some((item) => item.id === initialId));

  if (selected) {
    const [selectedKey, data] = selected;
    const showcaseItems = flattenShowcaseFeedPages(data.pages);
    const context = getShowcaseFeedSessionContext(data.pages);
    return showcaseItems.length ? {
      data: {
        showcaseItems,
        feedSessionId: context.feedSessionId,
        algorithmVersion: context.algorithmVersion,
      },
      updatedAt: oldestUpdatedAt(queryClient, [selectedKey]),
    } : undefined;
  }

  const saved = queryClient.getQueryData<CachedPages<ShowcaseFeedResponse>>(savedKey);
  const showcaseItems = dedupeById(readCachedPages(saved).flatMap((page) => page.items));
  return showcaseItems.length
    ? { data: { showcaseItems }, updatedAt: oldestUpdatedAt(queryClient, [savedKey]) }
    : undefined;
}

/**
 * `profile-generations` is paginated; `generations` stays single-page. Owner
 * posts are not merged in: generation viewers load linked-post details as
 * separate enrichment. The Failed scope's pages come last: a failure past the
 * library's loaded pages opens from them at once, and the library rule keeps
 * every other failure out of the reel.
 */
function cachedGenerations(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceSnapshot | undefined {
  return mergeCachedEntities(
    queryClient,
    [['profile-generations', userId], ['generations', userId], profileFailedGenerationsQueryKey(userId)],
    (data) => readCachedPages(data as CachedPages<GenerationListResponse> | undefined)
      .flatMap((page) => page.generations ?? []),
    (generations) => ({ generations })
  );
}

/** `profile-owner-posts` is paginated. */
function cachedOwnerPosts(queryClient: QueryClient, userId: string | undefined): ImmersiveSourceSnapshot | undefined {
  return mergeCachedEntities(
    queryClient,
    [['profile-owner-posts', userId]],
    (data) => readCachedPages(data as CachedPages<OwnerPostsResponse> | undefined)
      .flatMap((page) => page.posts ?? []),
    (ownerPosts) => ({ ownerPosts })
  );
}

/**
 * Merges overlapping caches of one entity type.
 *
 * Order follows the precedence of `keys`, so a viewer does not reshuffle with
 * cache ages. The *version* of an entity found in more than one cache comes from
 * the most recently updated one: fixed precedence used to let an hour-old grid
 * page overrule a copy another screen fetched a minute ago (audit C4).
 */
function mergeCachedEntities<TItem extends { id: string }>(
  queryClient: QueryClient,
  keys: QueryKey[],
  readItems: (data: unknown) => TItem[],
  toData: (items: TItem[]) => ImmersiveSourceData
): ImmersiveSourceSnapshot | undefined {
  const order: string[] = [];
  const newest = new Map<string, { item: TItem; updatedAt: number }>();
  const contributing: QueryKey[] = [];

  for (const key of keys) {
    const items = readItems(queryClient.getQueryData(key));
    if (!items.length) continue;
    contributing.push(key);
    const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
    for (const item of items) {
      const current = newest.get(item.id);
      if (!current) order.push(item.id);
      if (!current || updatedAt > current.updatedAt) newest.set(item.id, { item, updatedAt });
    }
  }

  if (!order.length) return undefined;
  return {
    data: toData(order.map((id) => newest.get(id)!.item)),
    updatedAt: oldestUpdatedAt(queryClient, contributing),
  };
}

/** The oldest `dataUpdatedAt` among the given caches; 0 for one that never loaded. */
function oldestUpdatedAt(queryClient: QueryClient, keys: QueryKey[]) {
  if (!keys.length) return 0;
  return keys.reduce(
    (oldest, key) => Math.min(oldest, queryClient.getQueryState(key)?.dataUpdatedAt ?? 0),
    Number.POSITIVE_INFINITY
  );
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

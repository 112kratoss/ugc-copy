import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
import { getCreationAvailability } from './creation-library';
import type {
  GenerationListItem,
  GenerationListResponse,
  OwnerPostListItem,
  OwnerPostsResponse,
  ShowcaseFeedResponse,
} from './types';

export const PROFILE_MEDIA_PAGE_SIZE = 24;
export const PROFILE_MEDIA_LOAD_MORE_COOLDOWN_MS = 800;
/** Four rows of three tiles — enough to make the grid scrollable so `onEndReached` can fire again. */
export const PROFILE_MEDIA_MIN_FILL_COUNT = 12;

/**
 * How the three profile libraries refresh, shared by every screen that reads
 * them: the grid, the card feed a tile opens, and the reel behind a card.
 *
 * React Query's automatic refetches of an infinite query request every loaded
 * page again, so a reader who had scrolled far into a library paid for all of it
 * on each return to the app. The libraries revalidate their first page on
 * qualifying events instead and merge it by identity (`profile-media-refresh`);
 * pull-to-refresh still collapses to one page first.
 */
export const PROFILE_LIBRARY_QUERY_BEHAVIOUR = {
  staleTime: 1000 * 60,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function profileGenerationsQueryOptions(
  api: Pick<MagicbookletApiClient, 'listGenerations'>,
  userId: string | undefined
) {
  return {
    queryKey: ['profile-generations', userId] as const,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listGenerations(true, {
      cursor: pageParam ?? undefined,
      limit: PROFILE_MEDIA_PAGE_SIZE,
    }),
    getNextPageParam: getNextProfileGenerationsCursor,
    ...PROFILE_LIBRARY_QUERY_BEHAVIOUR,
  };
}

export function profileOwnerPostsQueryOptions(
  api: Pick<MagicbookletApiClient, 'listOwnerPosts'>,
  userId: string | undefined
) {
  return {
    queryKey: ['profile-owner-posts', userId] as const,
    initialPageParam: 0 as number | string,
    // No sales summary: `/api/profile` carries the seller totals the Wallet draws.
    queryFn: ({ pageParam }: { pageParam: number | string }) => api.listOwnerPosts({
      includeArchived: true,
      limit: PROFILE_MEDIA_PAGE_SIZE,
      ...(typeof pageParam === 'string' ? { cursor: pageParam } : { offset: pageParam }),
      ...(pageParam === 0 || typeof pageParam === 'string' ? { pagination: 'cursor' } : {}),
      visibility: 'all',
    }),
    getNextPageParam: getNextProfileOwnerPostsOffset,
    ...PROFILE_LIBRARY_QUERY_BEHAVIOUR,
  };
}

export function profileSavedMediaQueryOptions(
  api: Pick<MagicbookletApiClient, 'getSavedMedia'>,
  userId: string | undefined
) {
  return {
    queryKey: ['profile-saved-media', userId] as const,
    initialPageParam: 0 as number | string,
    queryFn: ({ pageParam }: { pageParam: number | string }) => api.getSavedMedia({
      limit: PROFILE_MEDIA_PAGE_SIZE,
      ...(typeof pageParam === 'string' ? { cursor: pageParam } : { offset: pageParam }),
      ...(pageParam === 0 || typeof pageParam === 'string' ? { pagination: 'cursor' } : {}),
    }),
    getNextPageParam: getNextProfileSavedMediaOffset,
    ...PROFILE_LIBRARY_QUERY_BEHAVIOUR,
  };
}

/**
 * Every profile endpoint filters rows *after* the database page is cut (visibility, authorization,
 * blocked creators), and the grid filters again on `isGridReady`. A page can therefore contribute
 * zero tiles while more rows still exist, so paging must key off the server's `hasMore` flag alone —
 * never off how many items came back.
 */
export function getNextProfileGenerationsCursor(lastPage: GenerationListResponse): string | undefined {
  if (!lastPage.pagination?.hasMore) return undefined;
  return lastPage.pagination.nextCursor ?? undefined;
}

export function getNextProfileOwnerPostsOffset(lastPage: OwnerPostsResponse): number | string | undefined {
  if (!lastPage.pageInfo?.hasMore) return undefined;
  if ('nextCursor' in lastPage.pageInfo) return lastPage.pageInfo.nextCursor ?? undefined;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : undefined;
}

export function getNextProfileSavedMediaOffset(lastPage: ShowcaseFeedResponse): number | string | undefined {
  if (!lastPage.pageInfo?.hasMore) return undefined;
  if ('nextCursor' in lastPage.pageInfo) return lastPage.pageInfo.nextCursor ?? undefined;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : undefined;
}

/**
 * Offset paging over a table that is still being written to can repeat a row across pages, which
 * would collide in the grid's `keyExtractor`. Both flatteners dedupe by id.
 */
export function flattenProfileGenerationPages(
  pages: GenerationListResponse[] | undefined
): GenerationListItem[] {
  const seen = new Set<string>();
  const items: GenerationListItem[] = [];

  for (const page of pages ?? []) {
    for (const item of page.generations ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

export function flattenProfileOwnerPostPages(
  pages: OwnerPostsResponse[] | undefined
): OwnerPostListItem[] {
  const seen = new Set<string>();
  const items: OwnerPostListItem[] = [];

  for (const page of pages ?? []) {
    for (const item of page.posts ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

/**
 * Collapse a loaded infinite query back to its first page. Used before a refetch or an
 * invalidation so React Query refetches one page instead of every page loaded so far.
 */
export function truncateInfiniteDataToFirstPage<T>(
  current: InfiniteData<T> | undefined
): InfiniteData<T> | undefined {
  if (!current?.pages.length) return current;

  return {
    ...current,
    pages: current.pages.slice(0, 1),
    pageParams: current.pageParams.slice(0, 1),
  };
}

/**
 * Marks the Creations library stale, for the creator to call when a run it
 * started finishes: in-flight runs are not library members, and a library read
 * in the last minute stayed as it was. Stale only, nothing fetched now: Profile
 * reads its first page again the next time it is focused and merges it into
 * the pages the reader loaded, where a refetch would request every one of them.
 */
export function invalidateProfileCreations(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: ['profile-generations', userId], refetchType: 'none' });
}

/** How often Profile reads its first page again while a run on it is rendering. */
export const PROFILE_RENDERING_REFRESH_INTERVAL_MS = 15_000;

/**
 * The runs on the Creations strip: still rendering and not archived, in the
 * library's order. They are not library members (`isCreationLibraryMember`, the
 * rule the grid, the card feed and the reel share), so without the strip a run
 * left the creator's screen and appeared nowhere until it had finished.
 */
export function selectRenderingCreations<T extends GenerationListItem>(items: T[]): T[] {
  return items.filter((item) => !item.archived_at && getCreationAvailability(item) === 'rendering');
}

/**
 * The runs on the Creations "Failed" strip: failed and not archived, in the
 * library's order. Not library members either, so a run that failed while it
 * sat on the Rendering strip used to leave it for nowhere, reachable only from
 * its alert; the web Studio lists them under Failed.
 */
export function selectFailedCreations<T extends GenerationListItem>(items: T[]): T[] {
  return items.filter((item) => !item.archived_at && item.status === 'failed');
}

export function formatRenderingStartedLabel(createdAt: string | null | undefined, now: number) {
  const startedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return 'Started recently';
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return 'Started just now';
  if (minutes < 60) return `Started ${minutes} min ago`;
  return `Started ${Math.floor(minutes / 60)} h ago`;
}

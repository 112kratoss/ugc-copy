import type { InfiniteData } from '@tanstack/react-query';

import type { MagicbookletApiClient } from './api-client';
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
    queryFn: ({ pageParam }: { pageParam: string | null }) => api.listGenerations(false, {
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
    // Only the first page pays for the sales-summary aggregate.
    queryFn: ({ pageParam }: { pageParam: number | string }) => api.listOwnerPosts({
      includeArchived: true,
      includeSummary: pageParam === 0,
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

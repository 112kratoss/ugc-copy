import type { InfiniteData } from '@tanstack/react-query';

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
 * Every profile endpoint filters rows *after* the database page is cut (visibility, authorization,
 * blocked creators), and the grid filters again on `isGridReady`. A page can therefore contribute
 * zero tiles while more rows still exist, so paging must key off the server's `hasMore` flag alone —
 * never off how many items came back.
 */
export function getNextProfileGenerationsCursor(lastPage: GenerationListResponse): string | undefined {
  if (!lastPage.pagination?.hasMore) return undefined;
  return lastPage.pagination.nextCursor ?? undefined;
}

export function getNextProfileOwnerPostsOffset(lastPage: OwnerPostsResponse): number | undefined {
  if (!lastPage.pageInfo?.hasMore) return undefined;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : undefined;
}

export function getNextProfileSavedMediaOffset(lastPage: ShowcaseFeedResponse): number | undefined {
  if (!lastPage.pageInfo?.hasMore) return undefined;
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

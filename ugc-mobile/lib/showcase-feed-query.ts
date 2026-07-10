import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';

export const SHOWCASE_FEED_PAGE_SIZE = 12;
export const SHOWCASE_FEED_STALE_TIME_MS = 5 * 60 * 1000;

export type ShowcaseFeedSort = 'recent' | 'top-saves' | 'top-remixes' | 'top-sales';
export type ShowcaseFeedCategory = 'all' | ShowcaseFeedItem['category'];
export type ShowcaseFeedUnlock = 'all' | 'with-unlock' | 'free' | 'paid';
export type ShowcaseFeedResource = 'all' | 'prompt' | 'workflow' | 'files' | 'notes' | 'remix';
export type MobileShowcaseFeedFilterId = 'all' | 'unlocks' | 'free' | 'paid' | 'remixable';

export interface ShowcaseFeedFilters {
  category?: ShowcaseFeedCategory;
  resource?: ShowcaseFeedResource;
  sort?: ShowcaseFeedSort;
  tool?: string | null;
  unlock?: ShowcaseFeedUnlock;
}

export interface ShowcaseFeedPageParams extends ShowcaseFeedFilters {
  limit?: number;
  offset?: number;
}

export type ShowcaseFeedApiParams = Record<string, number | string>;

const DEFAULT_FEED_FILTERS = {
  category: 'all',
  resource: 'all',
  sort: 'recent',
  tool: 'all',
  unlock: 'all',
} as const;

export function createShowcaseFeedQueryKey(filters: ShowcaseFeedFilters = {}) {
  return [
    'showcase-feed',
    'infinite',
    {
      category: filters.category ?? DEFAULT_FEED_FILTERS.category,
      resource: filters.resource ?? DEFAULT_FEED_FILTERS.resource,
      sort: filters.sort ?? DEFAULT_FEED_FILTERS.sort,
      tool: filters.tool ?? DEFAULT_FEED_FILTERS.tool,
      unlock: filters.unlock ?? DEFAULT_FEED_FILTERS.unlock,
    },
  ] as const;
}

export function createShowcasePostQueryKey(postId: string | undefined, userId: string | null | undefined) {
  return ['showcase-post', postId, userId ?? undefined] as const;
}

export function resolveMobileShowcaseFeedFilterId(
  value: string | string[] | null | undefined
): MobileShowcaseFeedFilterId {
  const filter = Array.isArray(value) ? value[0] : value;
  if (
    filter === 'unlocks' ||
    filter === 'free' ||
    filter === 'paid' ||
    filter === 'remixable'
  ) {
    return filter;
  }

  return 'all';
}

export function normalizeShowcaseToolFilter(value: string | string[] | null | undefined) {
  const tool = (Array.isArray(value) ? value[0] : value)?.trim();
  return tool && tool !== DEFAULT_FEED_FILTERS.tool ? tool : null;
}

export function getShowcaseFeedPageParams(params: ShowcaseFeedPageParams = {}): ShowcaseFeedApiParams {
  const category = params.category ?? DEFAULT_FEED_FILTERS.category;
  const resource = params.resource ?? DEFAULT_FEED_FILTERS.resource;
  const sort = params.sort ?? DEFAULT_FEED_FILTERS.sort;
  const tool = params.tool ?? DEFAULT_FEED_FILTERS.tool;
  const unlock = params.unlock ?? DEFAULT_FEED_FILTERS.unlock;
  const query: ShowcaseFeedApiParams = {
    limit: params.limit ?? SHOWCASE_FEED_PAGE_SIZE,
    offset: params.offset ?? 0,
    sort,
  };

  if (category !== 'all') query.category = category;
  if (resource !== 'all') query.resource = resource;
  if (tool !== 'all') query.tool = tool;
  if (unlock !== 'all') query.unlock = unlock;

  return query;
}

export function flattenShowcaseFeedPages(pages: ShowcaseFeedResponse[] | undefined): ShowcaseFeedItem[] {
  const seen = new Set<string>();
  const items: ShowcaseFeedItem[] = [];

  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

export function findShowcaseFeedItemById(pages: ShowcaseFeedResponse[] | undefined, postId: string | undefined) {
  if (!postId) return undefined;

  for (const page of pages ?? []) {
    const item = page.items.find((candidate) => candidate.id === postId);
    if (item) return item;
  }

  return undefined;
}

export function getNextShowcaseFeedOffset(lastPage: ShowcaseFeedResponse): number | null {
  if (!lastPage.pageInfo?.hasMore) return null;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : null;
}

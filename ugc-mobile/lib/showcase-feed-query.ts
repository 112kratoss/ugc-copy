import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';

export const SHOWCASE_FEED_PAGE_SIZE = 12;
export const SHOWCASE_FEED_STALE_TIME_MS = 5 * 60 * 1000;

// Lane data older than this module was read by an earlier launch: the only way
// it reaches this one is Home's saved first page (`persisted-home-feed.ts`).
const laneReadsBeganAt = Date.now();

/** Whether lane data predates this launch, which only a restored page can. */
export function isLaneDataFromAnEarlierLaunch(dataUpdatedAt: number) {
  return dataUpdatedAt > 0 && dataUpdatedAt < laneReadsBeganAt;
}

/**
 * How long a ranked lane's pages count as fresh: for as long as the app runs.
 *
 * A reader of a lane whose pages are stale reads them again the moment it
 * moves onto the lane, whatever `refetchOnMount` says, and for an infinite
 * query that is every loaded page: for a ranked lane a new session, a new
 * order under posts the reader was just shown. With a five-minute age, a
 * filter or chip the reader came back to after that drew its lane as it was
 * left, then replaced it a few seconds later (owner, 2026-11-27). So a ranked
 * lane read in this launch does not age: it is read again when the reader asks
 * (a pull, Refresh, the "New posts" pill, product decision D2) and when
 * something invalidates it. The page a launch restores is the exception, by
 * design: it is owed one read as soon as Home mounts on it
 * (`persisted-home-feed.ts`).
 */
export function rankedLaneStaleTime(query: { state: { dataUpdatedAt: number } }) {
  return isLaneDataFromAnEarlierLaunch(query.state.dataUpdatedAt) ? SHOWCASE_FEED_STALE_TIME_MS : Infinity;
}

export type ShowcaseFeedSort = 'for-you' | 'recent' | 'top-saves' | 'top-remixes' | 'top-sales';
export type ShowcaseFeedCategory = 'all' | 'media' | ShowcaseFeedItem['category'];
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
  cursor?: string | null;
  feedSessionId?: string | null;
  limit?: number;
  offset?: number;
  /** A first page ranked ahead (`lib/explore-read-ahead.ts`), claimed by the read that shows it. */
  readAheadToken?: string | null;
  /** A For you first page the reader asked for again: ranked afresh (`lib/feed-fresh-ranking.ts`). */
  fresh?: boolean;
}

export interface ShowcaseFeedPageParam {
  cursor?: string;
  feedSessionId?: string;
  offset?: number;
}

export type ShowcaseFeedApiParams = Record<string, number | string>;

const DEFAULT_FEED_FILTERS = {
  category: 'all',
  resource: 'all',
  sort: 'for-you',
  tool: 'all',
  unlock: 'all',
} as const;

export function createShowcaseFeedQueryKey(
  filters: ShowcaseFeedFilters = {},
  identityUserId?: string | null
) {
  return [
    ...createShowcaseFeedViewerQueryKey(identityUserId),
    {
      category: filters.category ?? DEFAULT_FEED_FILTERS.category,
      resource: filters.resource ?? DEFAULT_FEED_FILTERS.resource,
      sort: filters.sort ?? DEFAULT_FEED_FILTERS.sort,
      tool: filters.tool ?? DEFAULT_FEED_FILTERS.tool,
      unlock: filters.unlock ?? DEFAULT_FEED_FILTERS.unlock,
    },
  ] as const;
}

/**
 * Every lane of one viewer. Keyed by the backend identity the feed request
 * carries (`identityUserId` from `useAuth`: a guest's uid or a registered
 * one), because the server ranks the page for that identity and refuses its
 * session, cursor and events to any other. A guest has a lane of its own, so
 * when the guest session arrives after a first page was read without one, the
 * lane is read again under the guest (audit 04-3). `'installation'` is a
 * device with no identity yet, whose requests carry only the installation id.
 */
export function createShowcaseFeedViewerQueryKey(identityUserId?: string | null) {
  return ['showcase-feed', 'infinite', identityUserId?.trim() || 'installation'] as const;
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
    sort,
  };

  if (params.cursor) {
    query.cursor = params.cursor;
    if (params.feedSessionId) query.feedSessionId = params.feedSessionId;
  } else {
    query.offset = params.offset ?? 0;
    if (params.readAheadToken && query.offset === 0) query.readAheadToken = params.readAheadToken;
    if (params.fresh && query.offset === 0 && sort === 'for-you') query.fresh = 1;
  }

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

export function getNextShowcaseFeedOffset(lastPage: ShowcaseFeedResponse): number | null {
  if (!lastPage.pageInfo?.hasMore) return null;
  return typeof lastPage.pageInfo.nextOffset === 'number' ? lastPage.pageInfo.nextOffset : null;
}

export function getNextShowcaseFeedPageParam(lastPage: ShowcaseFeedResponse): ShowcaseFeedPageParam | null {
  const cursor = lastPage.nextCursor ?? lastPage.pageInfo?.nextCursor;
  if (cursor && lastPage.pageInfo?.hasMore !== false) {
    return {
      cursor,
      ...(lastPage.feedSessionId ? { feedSessionId: lastPage.feedSessionId } : {}),
    };
  }

  const offset = getNextShowcaseFeedOffset(lastPage);
  return offset === null ? null : { offset };
}

export function getShowcaseFeedSessionContext(pages: ShowcaseFeedResponse[] | undefined) {
  let feedSessionId: string | null = null;
  let algorithmVersion: string | null = null;

  for (const page of pages ?? []) {
    feedSessionId ??= page.feedSessionId?.trim() || null;
    algorithmVersion ??= page.algorithmVersion?.trim() || null;
    if (feedSessionId && algorithmVersion) break;
  }

  return { feedSessionId, algorithmVersion };
}

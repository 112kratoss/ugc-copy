import type { MagicbookletApiClient } from './api-client';
import { FEED_WINDOW_PAGE_LIMIT, getPreviousFeedPageParam } from './feed-page-window';
import type { PreviewViewerSource } from './immersive-preview-view-model';
import {
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  getNextShowcaseFeedPageParam,
  getShowcaseFeedPageParams,
  type ShowcaseFeedCategory,
  type ShowcaseFeedFilters,
  type ShowcaseFeedPageParam,
  type ShowcaseFeedResource,
  type ShowcaseFeedSort,
  type ShowcaseFeedUnlock,
} from './showcase-feed-query';

/**
 * One lane of the showcase feed, as its query key holds it: every filter
 * spelled out. Explore's filters and tool, and Home's chips, are each one lane.
 */
export type ShowcaseFeedLane = {
  category: ShowcaseFeedCategory;
  resource: ShowcaseFeedResource;
  sort: ShowcaseFeedSort;
  tool: string;
  unlock: ShowcaseFeedUnlock;
};

const LANE_DEFAULTS: ShowcaseFeedLane = {
  category: 'all',
  resource: 'all',
  sort: 'for-you',
  tool: 'all',
  unlock: 'all',
};

const LANE_VALUES: { [Field in Exclude<keyof ShowcaseFeedLane, 'tool'>]: readonly ShowcaseFeedLane[Field][] } = {
  category: ['all', 'media', 'image', 'video', 'text'],
  resource: ['all', 'prompt', 'workflow', 'files', 'notes', 'remix'],
  sort: ['for-you', 'recent', 'top-saves', 'top-remixes', 'top-sales'],
  unlock: ['all', 'with-unlock', 'free', 'paid'],
};

const LANE_FIELDS = ['sort', 'category', 'resource', 'tool', 'unlock'] as const;

export function normalizeShowcaseFeedLane(filters: ShowcaseFeedFilters): ShowcaseFeedLane {
  return {
    category: filters.category ?? LANE_DEFAULTS.category,
    resource: filters.resource ?? LANE_DEFAULTS.resource,
    sort: filters.sort ?? LANE_DEFAULTS.sort,
    tool: filters.tool?.trim() || LANE_DEFAULTS.tool,
    unlock: filters.unlock ?? LANE_DEFAULTS.unlock,
  };
}

/**
 * The infinite query behind a lane, built one way wherever the lane is read:
 * the Explore and Home grids, and the reel opened from either, which reads and
 * pages the grid's own pages (audit 03-2, 03-4). One builder rather than three
 * copies, because a page is fetched with the options of whichever reader asked
 * for it: two copies that drifted would page one lane two ways.
 *
 * `identityUserId` is the backend identity, guest or registered, as
 * `createShowcaseFeedViewerQueryKey` explains.
 */
export function showcaseFeedLaneQueryOptions(
  api: Pick<MagicbookletApiClient, 'getShowcaseFeed'>,
  filters: ShowcaseFeedFilters,
  identityUserId: string | null | undefined,
) {
  return {
    queryKey: createShowcaseFeedQueryKey(filters, identityUserId),
    initialPageParam: { offset: 0 } as ShowcaseFeedPageParam,
    queryFn: ({ pageParam }: { pageParam: ShowcaseFeedPageParam }) => api.getShowcaseFeed(getShowcaseFeedPageParams({
      ...filters,
      ...pageParam,
    })),
    getNextPageParam: getNextShowcaseFeedPageParam,
    // A chronological lane keeps a window of pages and re-reads the ones it
    // let go by their offset. Ranked sessions are already limited to 60 items
    // on the server.
    getPreviousPageParam: getPreviousFeedPageParam,
    maxPages: filters.sort === 'recent' ? FEED_WINDOW_PAGE_LIMIT : 0,
    staleTime: SHOWCASE_FEED_STALE_TIME_MS,
    // A ranked lane is not read again because the app came back to the
    // foreground or a reader mounted. Such a refetch re-reads every loaded
    // page as a new ranked session: other posts under the reader's thumb, and
    // up to 60 deliveries served that nobody sees (audit 02-2). Pull-to-refresh
    // and the end-of-feed Refresh still renew it. Recent is a timeline and
    // keeps the defaults.
    ...(filters.sort === 'recent' ? {} : { refetchOnWindowFocus: false, refetchOnMount: false }),
  };
}

/**
 * A lane as a route parameter, `sort:for-you,category:media,unlock:free`: the
 * sort always, and every other filter that is not its default. Values are
 * URI-encoded, so a tool's slug can hold any character.
 */
export function serializeShowcaseFeedLane(filters: ShowcaseFeedFilters): string {
  const lane = normalizeShowcaseFeedLane(filters);
  return LANE_FIELDS
    .filter((field) => field === 'sort' || lane[field] !== LANE_DEFAULTS[field])
    .map((field) => `${field}:${encodeURIComponent(lane[field])}`)
    .join(',');
}

/** The lane a route names, or null for anything that is not one written by `serializeShowcaseFeedLane`. */
export function parseShowcaseFeedLane(value: string | null | undefined): ShowcaseFeedLane | null {
  if (!value?.trim()) return null;
  const lane: ShowcaseFeedLane = { ...LANE_DEFAULTS };
  let hasSort = false;
  for (const part of value.split(',')) {
    const separator = part.indexOf(':');
    if (separator <= 0) return null;
    const field = part.slice(0, separator);
    let fieldValue: string;
    try {
      fieldValue = decodeURIComponent(part.slice(separator + 1)).trim();
    } catch {
      return null;
    }
    if (!fieldValue) return null;
    if (field === 'tool') {
      lane.tool = fieldValue;
    } else if (field === 'category' || field === 'resource' || field === 'sort' || field === 'unlock') {
      if (!(LANE_VALUES[field] as readonly string[]).includes(fieldValue)) return null;
      (lane as Record<typeof field, string>)[field] = fieldValue;
      if (field === 'sort') hasSort = true;
    } else {
      return null;
    }
  }
  return hasSort ? lane : null;
}

/**
 * The lane a reel reads, when it reads one: a showcase-feed reel opened from a
 * grid that named its lane. Everything else (a link, a notification, another
 * source) loads its own window instead.
 */
export function readViewerLane(source: PreviewViewerSource, value: string | null | undefined) {
  return source === 'showcase-feed' ? parseShowcaseFeedLane(value) : null;
}

export type ReelEndSlideState = 'end' | 'error' | 'loading';

/**
 * What stands after a lane reel's last post: the end of the lane, a page that
 * failed to load (with its retry), or that retry under way. Nothing while more
 * posts are on their way, so the reel never offers a page that is about to be
 * replaced by posts.
 */
export function getReelEndSlideState(lane: {
  hasData: boolean;
  itemCount: number;
  hasNextPage: boolean;
  isFetchNextPageError: boolean;
  isFetchingNextPage: boolean;
}): ReelEndSlideState | null {
  if (!lane.hasData || lane.itemCount === 0) return null;
  if (lane.isFetchNextPageError) return lane.isFetchingNextPage ? 'loading' : 'error';
  return lane.hasNextPage ? null : 'end';
}

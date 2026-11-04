import {
  SHOWCASE_INITIAL_PAGE_SIZE,
  SHOWCASE_PAGE_SIZE,
  type ShowcaseSort,
} from '@/lib/showcase';

/**
 * How long a sort lane's shared first page (recent, top saves, top remixes,
 * top sales) is served from the data cache before a read rebuilds it. None of
 * those orders decays with time, and the tag is dropped whenever content
 * changes: every publish, edit, delete, take-down and account deletion calls
 * `invalidateShowcaseFeedCache()`, and feed maintenance does hourly after it
 * refreshes the stats. So the timer only bounds what changes with no tag drop:
 * the save, remix and comment counts on the cards, at most half an hour old.
 * It was 60 s, a rewrite of a 19-50 KB entry every minute or so of traffic
 * (usage audit, 2026-11-04).
 */
export const SHOWCASE_FEED_BASE_PAGE_REVALIDATE_SECONDS = 1800;

/**
 * How long the identity-less For you first page is served from the data
 * cache. Its ranking has time-decay features and a shared seed that turns
 * every ten minutes (`FEED_SHARED_SEED_BUCKET_MS`), so it is held for one seed
 * bucket: anonymous readers still see the rotation at its own cadence. Content
 * changes drop it at once, as above.
 */
export const SHOWCASE_FOR_YOU_BOOTSTRAP_REVALIDATE_SECONDS = 600;

function isSupportedBootstrapLimit(limit: number) {
  return limit === SHOWCASE_INITIAL_PAGE_SIZE || limit === SHOWCASE_PAGE_SIZE;
}

export function shouldCacheIdentitylessForYouBootstrap(options: {
  sort: ShowcaseSort;
  offset: number;
  limit: number;
  toolSlug?: string | null;
  viewerUserId?: string | null;
  anonymousKeyHash?: string | null;
  cursor?: string | null;
  bypassCache?: boolean;
}) {
  return options.sort === 'for-you'
    && options.offset === 0
    && isSupportedBootstrapLimit(options.limit)
    && !options.toolSlug
    && !options.viewerUserId
    && !options.anonymousKeyHash
    && !options.cursor
    && !options.bypassCache;
}

export function shouldCacheViewerNeutralShowcaseBasePage(options: {
  offset: number;
  limit: number;
  toolSlug?: string | null;
  bypassCache?: boolean;
}) {
  return options.offset === 0
    && (options.limit === 1 || isSupportedBootstrapLimit(options.limit))
    && !options.toolSlug
    && !options.bypassCache;
}

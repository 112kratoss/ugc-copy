import { createShowcaseFeedQueryKey, type ShowcaseFeedFilters } from '@/lib/showcase-feed-query';

/**
 * A reader's own refresh of a lane (a pull to refresh, "New posts", the end of
 * the feed's Refresh): the next first page that lane reads asks the server for
 * a fresh ranking (`fresh=1`). Without it, a For you first page read within two
 * minutes of the last ranking is served that same ranking, so a pull showed the
 * very posts it started from.
 *
 * One request per refresh, taken by the read it is for: a later refetch nobody
 * asked for (an invalidation, a mount) is served as before, and the server's
 * window still keeps such a read from serving page one twice.
 */
const requested = new Set<string>();

function laneKey(filters: ShowcaseFeedFilters, identityUserId: string | null | undefined) {
  return JSON.stringify(createShowcaseFeedQueryKey(filters, identityUserId));
}

/** Asked by the screen just before it reads the lane's first page again. */
export function requestFreshRanking(filters: ShowcaseFeedFilters, identityUserId: string | null | undefined) {
  requested.add(laneKey(filters, identityUserId));
}

/** Taken by the lane's first-page read: true once per request. */
export function takeFreshRanking(filters: ShowcaseFeedFilters, identityUserId: string | null | undefined) {
  return requested.delete(laneKey(filters, identityUserId));
}

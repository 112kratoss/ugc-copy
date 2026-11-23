import { createShowcaseFeedQueryKey, type ShowcaseFeedFilters } from '@/lib/showcase-feed-query';

/**
 * A reader's own refresh of a lane (a pull to refresh, "New posts", the end of
 * the feed's Refresh): the lane's next first-page read asks the server for a
 * fresh ranking (`fresh=1`). Without it, a For you first page read within two
 * minutes of the last ranking is served that same ranking, so a pull showed the
 * very posts it started from.
 *
 * A request stands until a first-page read that asked with it is answered, so a
 * retry of a failed read asks again, and it lapses after `FRESH_RANKING_TTL_MS`,
 * so one no read took cannot reach a read nobody asked for minutes later. A
 * screen asks through `runLaneRefresh`, which asks only for a refresh that
 * starts a read of its own: never for a lane still loading (its refetch joins
 * the load on its way), nor a second time while the lane's refresh is out.
 */
export const FRESH_RANKING_TTL_MS = 30_000;

const requested = new Map<string, number>();

function laneKey(filters: ShowcaseFeedFilters, identityUserId: string | null | undefined) {
  return JSON.stringify(createShowcaseFeedQueryKey(filters, identityUserId));
}

/** Asked by the screen just before it reads the lane's first page again. */
export function requestFreshRanking(
  filters: ShowcaseFeedFilters,
  identityUserId: string | null | undefined,
  now = Date.now(),
) {
  requested.set(laneKey(filters, identityUserId), now);
}

/** Read by each try of the lane's first-page read: true while a request stands. */
export function isFreshRankingRequested(
  filters: ShowcaseFeedFilters,
  identityUserId: string | null | undefined,
  now = Date.now(),
) {
  const key = laneKey(filters, identityUserId);
  const at = requested.get(key);
  if (at === undefined) return false;
  if (now - at > FRESH_RANKING_TTL_MS) {
    requested.delete(key);
    return false;
  }
  return true;
}

/** The read that asked was answered: the request is spent. */
export function settleFreshRanking(filters: ShowcaseFeedFilters, identityUserId: string | null | undefined) {
  requested.delete(laneKey(filters, identityUserId));
}

export function resetFreshRankingForTests() {
  requested.clear();
}

/** The refresh a screen has out, by lane: `useRef` of this, one per screen. */
export type LaneRefreshInFlight = { current: { lane: string; refresh: Promise<unknown> } | null };

/**
 * A reader's refresh of a lane's first page, one at a time. A second one while
 * the first is out (a pull, then "New posts" before it lands) waits for it:
 * starting again would cancel the first read on the phone only, and the server
 * would rank and serve a page nobody sees. `start` trims the lane and reads it
 * again; the fresh ranking is asked for only when the lane has pages, since a
 * lane still loading has its read on the way, which a refetch joins.
 */
export function runLaneRefresh(
  inFlight: LaneRefreshInFlight,
  {
    filters,
    identityUserId,
    lanePages,
    start,
  }: {
    filters: ShowcaseFeedFilters;
    identityUserId: string | null | undefined;
    lanePages: number;
    start: () => Promise<unknown>;
  },
): Promise<unknown> {
  const lane = laneKey(filters, identityUserId);
  if (inFlight.current?.lane === lane) return inFlight.current.refresh;
  if (lanePages > 0) requestFreshRanking(filters, identityUserId);
  const refresh: Promise<unknown> = start().finally(() => {
    if (inFlight.current?.refresh === refresh) inFlight.current = null;
  });
  inFlight.current = { lane, refresh };
  return refresh;
}

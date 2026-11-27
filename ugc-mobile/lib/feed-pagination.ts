/**
 * How far from its end a paged list asks for its next page: FlashList's
 * `onEndReachedThreshold`, in heights of the list itself, so two screens of
 * rows still to come. A third of a screen (0.32) let a fast fling on the S24
 * run past the loaded rows into a blank strip and a spinner for 0.5 to 0.6 s,
 * three times in one pass over the profile grid (device feel audit, 2026-11-27).
 *
 * A runway this long means a page can land with the list still within it, and
 * inside the gate's cooldown: FlashList asks again as it lands, the gate
 * refuses, and FlashList does not ask again until its data changes. So every
 * list on it asks again as the cooldown ends (`useNextFeedPageRequest`, or
 * `useAskAgainAfterCooldown` where a screen keeps the gate's refs itself).
 */
export const FEED_NEXT_PAGE_RUNWAY_SCREENS = 2;

/**
 * Home's lanes and Explore keep their short runways. The server marks every post
 * on a page it hands out as served to that viewer
 * (`src/lib/showcase-feed-personalization.ts`), and for six hours the ranking reads
 * a served post the viewer never reached as passed over: a lighter penalty and no
 * cold-start slot. A page asked two screens early would count against posts nobody
 * saw; Explore's first page of 12 is about two screens tall, so it would read its
 * second at once. The profile grid and a creator's page serve no deliveries.
 */
export const HOME_LANE_NEXT_PAGE_RUNWAY_SCREENS = 0.32;
export const EXPLORE_NEXT_PAGE_RUNWAY_SCREENS = 0.5;

export type FeedPaginationGate = {
  cooldownMs: number;
  hasNextPage: boolean | undefined;
  isBusy: boolean;
  isRequestInFlight: boolean;
  lastRequestedAt: number;
  lastRequestedPageCount: number | null;
  now: number;
  pageCount: number;
};

/**
 * Prevents duplicate end-reached requests without tying pagination to the
 * number of rendered cards. A successful page can legitimately add no visible
 * items after deduplication or surface-specific filtering.
 */
export function canRequestNextFeedPage(gate: FeedPaginationGate) {
  return nextFeedPageRequestDelay(gate) === 0;
}

/**
 * The gate's one list of conditions, as how long a request has to wait: 0 when
 * it may go now. When only time stands in its way, the rest of the cooldown (at
 * most a cooldown, whatever the clock does), or another cooldown for a request
 * that has landed and not yet settled; neither renders again as it ends, so a
 * caller that must not lose the request sets a timer for it. Null when what
 * refuses it renders again as it changes: no next page, the query busy, no page
 * landed since the last request.
 */
export function nextFeedPageRequestDelay({
  cooldownMs,
  hasNextPage,
  isBusy,
  isRequestInFlight,
  lastRequestedAt,
  lastRequestedPageCount,
  now,
  pageCount,
}: FeedPaginationGate): number | null {
  if (!hasNextPage || isBusy || lastRequestedPageCount === pageCount) return null;
  const cooldownLeft = Math.min(lastRequestedAt + cooldownMs - now, cooldownMs);
  if (cooldownLeft > 0) return cooldownLeft;
  return isRequestInFlight ? cooldownMs : 0;
}

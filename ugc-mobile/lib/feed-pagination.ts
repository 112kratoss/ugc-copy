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

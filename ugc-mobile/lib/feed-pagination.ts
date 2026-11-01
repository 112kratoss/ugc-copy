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
export function canRequestNextFeedPage({
  cooldownMs,
  hasNextPage,
  isBusy,
  isRequestInFlight,
  lastRequestedAt,
  lastRequestedPageCount,
  now,
  pageCount,
}: FeedPaginationGate) {
  return Boolean(hasNextPage)
    && !isBusy
    && !isRequestInFlight
    && lastRequestedPageCount !== pageCount
    && now - lastRequestedAt >= cooldownMs;
}

/**
 * How long a request the gate refused has to wait before it could pass, when
 * only time stands in its way: the cooldown, or a request that has landed and
 * not yet settled. Neither renders again as it ends, so a caller that asks by
 * itself rather than from a scroll (a grid topping itself up) sets a timer for
 * it. Null when the request would pass, or when what refuses it renders again
 * as it changes: no next page, the query busy, no page landed since the last
 * request.
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
  const cooldownLeft = lastRequestedAt + cooldownMs - now;
  if (cooldownLeft > 0) return cooldownLeft;
  return isRequestInFlight ? cooldownMs : null;
}

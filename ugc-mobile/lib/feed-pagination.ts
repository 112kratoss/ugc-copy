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

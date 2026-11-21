import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { nextFeedPageRequestDelay } from './feed-pagination';

// Drops the page request the gate put off until its cooldown ends.
function cancelAskAgain(timer: { current: ReturnType<typeof setTimeout> | null }) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/**
 * A list's next page, asked for through the shared gate (`lib/feed-pagination.ts`),
 * so that the end of the list and a screen's own top-up can both ask and a
 * burst of asks fetches one page.
 *
 * A page that lands inside the gate's cooldown is refused at the very render
 * that brings it, whoever asks (FlashList asks again as a page lands), and no
 * render comes when the cooldown ends: a short list stopped at its end until
 * the reader scrolled away and back, which a list too short to scroll cannot
 * do. The request is asked again then, by a timer, through the latest render's
 * request. One that comes while the screen is covered is asked once it is back.
 */
export function useNextFeedPageRequest({
  list,
  enabled,
  cooldownMs,
  hasNextPage,
  isBusy,
  isFetchNextPageError,
  pageCount,
  fetchNextPage,
}: {
  /** The list paged. Another starts afresh: what was asked of the last says nothing of it. */
  list: string;
  /** False while the screen is covered, when nothing is asked. */
  enabled: boolean;
  cooldownMs: number;
  hasNextPage: boolean | undefined;
  /** The list's query is fetching, a page or a refresh. */
  isBusy: boolean;
  isFetchNextPageError: boolean;
  pageCount: number;
  fetchNextPage: () => Promise<unknown>;
}) {
  const inFlightRef = useRef(false);
  const lastAskedAtRef = useRef(0);
  const lastAskedPageCountRef = useRef<number | null>(null);
  // The request the gate put off until its cooldown ends, whether the last one
  // came while the screen was covered, and the latest `requestNextPage` for
  // either to ask with.
  const askAgainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askedWhileCoveredRef = useRef(false);
  const requestNextPageRef = useRef<() => void>(() => undefined);
  const nextPageFailedRef = useRef(false);

  const requestNextPage = useCallback(() => {
    cancelAskAgain(askAgainTimerRef);
    askedWhileCoveredRef.current = !enabled;
    if (!enabled) return;
    const now = Date.now();
    const wait = nextFeedPageRequestDelay({
      cooldownMs,
      hasNextPage,
      isBusy,
      isRequestInFlight: inFlightRef.current,
      lastRequestedAt: lastAskedAtRef.current,
      lastRequestedPageCount: lastAskedPageCountRef.current,
      now,
      pageCount,
    });
    if (wait === null) return;
    if (wait > 0) {
      askAgainTimerRef.current = setTimeout(() => {
        askAgainTimerRef.current = null;
        requestNextPageRef.current();
      }, wait);
      return;
    }

    inFlightRef.current = true;
    lastAskedAtRef.current = now;
    lastAskedPageCountRef.current = pageCount;
    void fetchNextPage().finally(() => {
      inFlightRef.current = false;
    });
  }, [cooldownMs, enabled, fetchNextPage, hasNextPage, isBusy, pageCount]);
  useEffect(() => {
    requestNextPageRef.current = requestNextPage;
  }, [requestNextPage]);

  /** The footer's Retry: the page asked for again, whatever was asked last. */
  const retryNextPage = useCallback(() => {
    lastAskedPageCountRef.current = null;
    lastAskedAtRef.current = 0;
    requestNextPage();
  }, [requestNextPage]);

  /** Forgets what was asked, for a list cut back to its first page and read again. */
  const resetPageRequests = useCallback(() => {
    inFlightRef.current = false;
    lastAskedAtRef.current = 0;
    lastAskedPageCountRef.current = null;
    askedWhileCoveredRef.current = false;
    cancelAskAgain(askAgainTimerRef);
  }, []);

  // Another list, before its first ask: FlashList asks from an effect of its
  // own, which runs ahead of the screen's.
  useLayoutEffect(() => {
    resetPageRequests();
  }, [list, resetPageRequests]);

  useEffect(() => {
    if (enabled && askedWhileCoveredRef.current) requestNextPage();
  }, [enabled, requestNextPage]);

  // A failed page keeps the gate shut, as no page has landed since it was asked
  // for, so only the footer's Retry asks for it again. A refresh that clears the
  // error with the page still missing takes the footer away: the page is asked
  // for here instead, or a short list would stop with no way on.
  useEffect(() => {
    const failed = nextPageFailedRef.current;
    nextPageFailedRef.current = isFetchNextPageError;
    if (!failed || isFetchNextPageError || lastAskedPageCountRef.current !== pageCount) return;
    lastAskedPageCountRef.current = null;
    requestNextPage();
  }, [isFetchNextPageError, pageCount, requestNextPage]);

  useEffect(() => () => cancelAskAgain(askAgainTimerRef), []);

  return { requestNextPage, retryNextPage, resetPageRequests };
}

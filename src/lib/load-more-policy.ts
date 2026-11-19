/**
 * When a list asks for its next page by itself, for the lists that load more as the reader nears
 * their end: Home's feed (`FeedClient`) and Marketplace's recipes (`MarketplaceBrowser`, and the
 * first-paint shell that hands it over, `MarketplaceBootstrap`).
 */

/** How near the list's end comes to the window, above or below it, before the next page is asked for. */
export const LOAD_MORE_ROOT_MARGIN = '600px 0px';

/**
 * How long a list waits before asking again by itself after a page failed: the first wait, then
 * the second, then only a press asks. Without a wait the list's end, still in view, made a fresh
 * observer fire at once after every failure, and a phone sent Home 225 failing requests in 5.5 s
 * (speed baseline, 2026-11-19), each a function call and a rate-limit write when it reached the
 * server. Any page that loads starts the count over, and the network coming back (`online`) gives
 * a failed page its waits anew.
 */
export const LOAD_MORE_RETRY_DELAYS_MS = [2_000, 8_000] as const;

/**
 * The wait before a list asks for its next page by itself, after `failures` pages failed in a row:
 * none before the first failure, then each delay in turn, and null once they are spent, when only
 * a press asks.
 */
export function loadMoreRetryDelayMs(failures: number): number | null {
  if (failures <= 0) return 0;
  return failures <= LOAD_MORE_RETRY_DELAYS_MS.length ? LOAD_MORE_RETRY_DELAYS_MS[failures - 1] : null;
}

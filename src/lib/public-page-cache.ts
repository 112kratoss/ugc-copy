import 'server-only';

import { unstable_cache } from 'next/cache';

/**
 * How long a cached public page (`/showcase/[id]`, `/creators/[username]`,
 * `/marketplace`) may go without an event refreshing it. Every publish, edit,
 * archive, delete, profile change, account deletion and console moderation
 * decision invalidates the pages' tag along with the feed's
 * (`invalidateShowcaseFeedCache`), and every sale or free unlock the
 * marketplace's, with `{ expire: 0 }`, so the next visitor waits for a fresh
 * render instead of being served the old one.
 *
 * Five minutes, not an hour, for one path that invalidates nothing: the
 * moderation CLI (`npm run ops:moderation -- take-down-post`, the runbook's
 * procedure for a reported post) runs outside Next, where `revalidateTag`
 * cannot reach the cache. A post it takes down leaves Explore within the feed
 * cache's minute; a page here that is being visited drops it within this
 * window (the first visit after it is still answered from the cache while the
 * page is drawn again), and no page is served older than an hour
 * (`expireTime` in next.config.ts), whether or not the hourly feed
 * maintenance run, which invalidates only after its RPCs succeed, got there.
 * Five minutes is what the runbook already accepts for the template catalog
 * after a take-down; the post's media goes at once, deleted from storage. An
 * hour is safe once that command invalidates the tag too.
 *
 * Each page's `export const revalidate` repeats the number (Next reads the
 * segment config as a literal); the pages' tests hold them equal.
 */
export const PUBLIC_PAGE_REVALIDATE_SECONDS = 300;

/**
 * The cached public pages' own tag, which every read through
 * `cachePublicPageRead` carries into its page's cache entry. Only a change
 * those pages draw expires it (`invalidateShowcaseFeedCache`); a block or a
 * report changes only the feeds (`invalidateShowcaseFeedCacheOnly`): the pages
 * are drawn for no one, a block is applied in the browser, and a report hides
 * nothing until a moderator decides.
 */
export const PUBLIC_PAGE_CACHE_TAG = 'public-pages:v1';

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

/**
 * A page's data read, cached and tagged so that the page render it feeds
 * carries the tags too: Next adds an `unstable_cache` call's tags to the ISR
 * entry of the page that made it, which is how `revalidateTag` reaches a page
 * whose reads go through supabase-js rather than a tagged `fetch`. It is
 * tagged `PUBLIC_PAGE_CACHE_TAG` and any `extraTags` the page names. Its
 * `revalidate` is the backstop above, so it never shortens the page's own.
 *
 * It must only ever read what any visitor may see: its answer is shared by
 * everyone who opens the page. Nothing here may depend on a session, a cookie,
 * a header or the query string.
 *
 * Outside a Next request (vitest, scripts) there is no incremental cache, and
 * the read runs uncached, as `getMarketplaceResourceList` does in that case.
 */
export function cachePublicPageRead<Args extends string[], Result>(
  read: (...args: Args) => Promise<Result>,
  keyParts: string[],
  extraTags: string[] = [],
): (...args: Args) => Promise<Result> {
  const cachedRead = unstable_cache(read, keyParts, {
    revalidate: PUBLIC_PAGE_REVALIDATE_SECONDS,
    tags: [PUBLIC_PAGE_CACHE_TAG, ...extraTags],
  });

  return async (...args: Args) => {
    try {
      return await cachedRead(...args);
    } catch (error) {
      if (isMissingIncrementalCacheError(error)) {
        return read(...args);
      }
      throw error;
    }
  };
}

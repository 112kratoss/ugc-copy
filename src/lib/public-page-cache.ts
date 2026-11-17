import 'server-only';

import { unstable_cache } from 'next/cache';

import { withCachedPageMediaSignatures } from '@/lib/media-signature-scope';
import { normalizeUsername } from '@/lib/profile';

/**
 * How long a cached public page (`/showcase/[id]`, `/creators/[username]`,
 * `/marketplace`) may go without an event refreshing it. A change those pages
 * draw refreshes them by tag (`showcase-feed-cache.ts` says which tag each
 * change reaches): a removal expires every page at once, so the next visitor
 * waits for a fresh render; any other change marks the pages that draw it
 * stale, so the next visitor is answered from the cache while the page is
 * drawn again behind them.
 *
 * Five minutes, not an hour, for the paths that refresh nothing: the
 * moderation CLI (`npm run ops:moderation -- take-down-post`, the runbook's
 * procedure for a reported post) runs outside Next, where `revalidateTag`
 * cannot reach the cache, and asks the app to expire the pages
 * (`/api/cron/showcase-feed-invalidate`) only when it has the site's address
 * and the cron secret, and the request gets through; counts (saves, comments,
 * remixes, sales) move with no event at all. A post the CLI takes down leaves
 * Explore within the feed cache's minute; a page here that is being visited
 * drops it within this window (the first visit after it is still answered
 * from the cache while the page is drawn again), and no page is served older
 * than an hour (`expireTime` in next.config.ts). Five minutes is what the
 * runbook already accepts for the template catalog after a take-down; the
 * post's media goes at once, deleted from storage.
 *
 * Each page's `export const revalidate` repeats the number (Next reads the
 * segment config as a literal); the pages' tests hold them equal.
 */
export const PUBLIC_PAGE_REVALIDATE_SECONDS = 300;

/**
 * The cached public pages' removal tag, which every read through
 * `cachePublicPageRead` carries into its page's cache entry. Only a removal
 * expires it (`invalidateShowcaseFeedCache`: a delete, a move to private, an
 * archive, a moderation take-down, an account deletion), and always at once
 * (`{ expire: 0 }`), never with a profile that serves the page stale: a
 * removed post is never shown again from a cached page. It is also the
 * operator's lever (`/api/cron/showcase-feed-invalidate`).
 *
 * Every tag here is expired with one profile only. Next keeps one stale time
 * and one expiry time per tag, and a later `'max'` overwrites an earlier
 * `{ expire: 0 }`'s expiry, so a page drawn before a removal and not visited
 * since would be served once more if the same tag were later refreshed in
 * the background. A block or a report changes only the feeds
 * (`invalidateShowcaseFeedCacheOnly`): the pages are drawn for no one, a
 * block is applied in the browser, and a report hides nothing until a
 * moderator decides.
 */
export const PUBLIC_PAGE_CACHE_TAG = 'public-pages:v1';

/**
 * Every cached public page, refreshed in the background (`'max'` only): for a
 * change whose pages cannot be named, a profile (its name and picture are on
 * every post page of the creator's, on every remix credit that names them and
 * on the storefront's cards) or a repaired preview.
 */
export const PUBLIC_PAGE_REFRESH_TAG = 'public-pages:refresh:v1';

/**
 * One post page, by the id in its address (`'max'` only): the post's own
 * changes, and those of a post its remix credit names. A legacy address, the
 * post's creation's id, carries the tag of that id.
 */
export function publicPostPageTag(postId: string): string {
  return `public-page:post:${postId.trim().toLowerCase()}`;
}

/**
 * One post page, drawn again at once (`{ expire: 0 }` only) when its cached
 * copy cannot be served even once: for its post coming into view (while the
 * post was private, archived or hidden its page could only hold a not-found,
 * which would tell the first visitor of a post just published or brought back
 * that it does not exist), and for an edit that deleted media the page drew.
 */
export function publicPostArrivalTag(postId: string): string {
  return `public-page:post-arrival:${postId.trim().toLowerCase()}`;
}

/** One creator's page, by the creator's user id (`'max'` only): a change to a post it lists. */
export function publicCreatorPageTag(creatorId: string): string {
  return `public-page:creator:${creatorId.trim().toLowerCase()}`;
}

/**
 * The creator page at one handle, for the handle coming into use
 * (`{ expire: 0 }` only): a page drawn while no account had the handle holds a
 * not-found, which is dropped at once when a profile takes the handle. Null
 * for text that is no handle.
 */
export function publicCreatorHandleTag(handle: string): string | null {
  const normalized = normalizeUsername(handle);
  return normalized ? `public-page:creator-handle:${normalized}` : null;
}

/** The tags a post page's read carries, from the id in its address. */
export function showcasePostPageCacheTags(id: string): string[] {
  return [publicPostPageTag(id), publicPostArrivalTag(id)];
}

/** The tags the creator page's lookup of its handle carries. */
export function creatorHandlePageCacheTags(handle: string): string[] {
  const tag = publicCreatorHandleTag(handle);
  return tag ? [tag] : [];
}

/** The tags the creator page's read carries, from the creator its handle named. */
export function creatorPageCacheTags(creatorId: string): string[] {
  return [publicCreatorPageTag(creatorId)];
}

function isMissingIncrementalCacheError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('incrementalCache missing');
}

/**
 * A page's data read, cached and tagged so that the page render it feeds
 * carries the tags too: Next adds an `unstable_cache` call's tags to the ISR
 * entry of the page that made it, which is how `revalidateTag` reaches a page
 * whose reads go through supabase-js rather than a tagged `fetch`. It is
 * tagged `PUBLIC_PAGE_CACHE_TAG`, `PUBLIC_PAGE_REFRESH_TAG` and the page's own
 * `pageTags`: a list, or the list a call's arguments name (a post's id from
 * the address), in which case the cache is set up for each call, since
 * `unstable_cache` fixes its tags when it is made. Its key is the read and
 * its arguments either way. Its `revalidate` is the backstop above, so it
 * never shortens the page's own.
 *
 * A page refreshed in the background draws itself again with this read: the
 * read's own entry carries the same tags, so it is stale too, and Next reads
 * it again before drawing (`unstable_cache` waits for a stale entry while a
 * page is being drawn), never handing the page the data it already showed.
 *
 * It must only ever read what any visitor may see: its answer is shared by
 * everyone who opens the page. Nothing here may depend on a session, a cookie,
 * a header or the query string.
 *
 * A link the read signs lasts longer than any cached copy of the page can be
 * served (`withCachedPageMediaSignatures`), so a page is never shown with
 * media whose link has run out.
 *
 * Outside a Next request (vitest, scripts) there is no incremental cache, and
 * the read runs uncached, as `getMarketplaceResourceList` does in that case.
 */
export function cachePublicPageRead<Args extends string[], Result>(
  read: (...args: Args) => Promise<Result>,
  keyParts: string[],
  pageTags: string[] | ((...args: Args) => string[]) = [],
): (...args: Args) => Promise<Result> {
  const cacheRead = (tags: string[]) => unstable_cache(read, keyParts, {
    revalidate: PUBLIC_PAGE_REVALIDATE_SECONDS,
    tags: [PUBLIC_PAGE_CACHE_TAG, PUBLIC_PAGE_REFRESH_TAG, ...tags],
  });
  const fixedRead = typeof pageTags === 'function' ? null : cacheRead(pageTags);

  return (...args: Args) => withCachedPageMediaSignatures(async () => {
    try {
      const cachedRead = fixedRead ?? cacheRead((pageTags as (...args: Args) => string[])(...args));
      return await cachedRead(...args);
    } catch (error) {
      if (isMissingIncrementalCacheError(error)) {
        return read(...args);
      }
      throw error;
    }
  });
}

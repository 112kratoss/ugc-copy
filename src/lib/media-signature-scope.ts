import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How long a signed media link lasts when it is signed for a cached public
 * page (`cachePublicPageRead`: the post, creator and marketplace pages).
 *
 * A legacy post's cover kept only in its creator's own folder has no address
 * anyone else can use: storage lets only the creator read that folder, and the
 * media proxy (`/api/media`) signs as the viewer, so it answers a visitor with
 * nothing. The page's read signs it with the service role instead
 * (`resolveOwnedStoredMediaUrl`). Signed for the usual hour, inside a page
 * served for up to an hour after it was drawn (`expireTime`), from data read
 * up to five minutes before that, and kept five minutes more by the client
 * router, the link could stop working on a page still being shown. Signed
 * inside a cached page's read it lasts two hours, longer than any cached copy
 * of the page can be served; everywhere else it keeps its hour. A share image
 * is never such a link (the post page's `resolveShowcaseOgImage`).
 */
export const CACHED_PAGE_MEDIA_SIGNATURE_SECONDS = 2 * 60 * 60;

const scope = new AsyncLocalStorage<{ seconds: number }>();

/** Runs a cached page's read, every link it signs lasting `CACHED_PAGE_MEDIA_SIGNATURE_SECONDS`. */
export function withCachedPageMediaSignatures<T>(read: () => T): T {
  return scope.run({ seconds: CACHED_PAGE_MEDIA_SIGNATURE_SECONDS }, read);
}

/** How long a link signed now lasts: `defaultSeconds`, or longer inside a cached page's read. */
export function mediaSignatureSeconds(defaultSeconds: number): number {
  const scoped = scope.getStore()?.seconds;
  return scoped !== undefined && scoped > defaultSeconds ? scoped : defaultSeconds;
}

import { SHOWCASE_PAGE_SIZE, type ShowcaseSort } from '@/lib/showcase';

export function shouldCacheIdentitylessForYouBootstrap(options: {
  sort: ShowcaseSort;
  offset: number;
  limit: number;
  toolSlug?: string | null;
  viewerUserId?: string | null;
  anonymousKeyHash?: string | null;
  cursor?: string | null;
  bypassCache?: boolean;
}) {
  return options.sort === 'for-you'
    && options.offset === 0
    && options.limit === SHOWCASE_PAGE_SIZE
    && !options.toolSlug
    && !options.viewerUserId
    && !options.anonymousKeyHash
    && !options.cursor
    && !options.bypassCache;
}

export function shouldCacheViewerNeutralShowcaseBasePage(options: {
  offset: number;
  limit: number;
  toolSlug?: string | null;
  bypassCache?: boolean;
}) {
  return options.offset === 0
    && (options.limit === 1 || options.limit === SHOWCASE_PAGE_SIZE)
    && !options.toolSlug
    && !options.bypassCache;
}

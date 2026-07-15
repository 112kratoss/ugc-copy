import { describe, expect, it } from 'vitest';

import {
  shouldCacheIdentitylessForYouBootstrap,
  shouldCacheViewerNeutralShowcaseBasePage,
} from '@/lib/showcase-feed-cache-policy';
import { SHOWCASE_INITIAL_PAGE_SIZE, SHOWCASE_PAGE_SIZE } from '@/lib/showcase';

describe('showcase For You bootstrap cache policy', () => {
  it('caches only the identity-free first page', () => {
    const bootstrap = { sort: 'for-you' as const, offset: 0, limit: SHOWCASE_INITIAL_PAGE_SIZE };
    expect(shouldCacheIdentitylessForYouBootstrap(bootstrap)).toBe(true);
    expect(shouldCacheIdentitylessForYouBootstrap({
      ...bootstrap,
      limit: SHOWCASE_PAGE_SIZE,
    })).toBe(true);

    for (const options of [
      { ...bootstrap, sort: 'recent' as const },
      { ...bootstrap, offset: SHOWCASE_INITIAL_PAGE_SIZE },
      { ...bootstrap, limit: 24 },
      { ...bootstrap, toolSlug: 'arbitrary-tool' },
      { ...bootstrap, viewerUserId: 'user-1' },
      { ...bootstrap, anonymousKeyHash: 'anonymous-hash' },
      { ...bootstrap, cursor: 'next-page' },
      { ...bootstrap, bypassCache: true },
    ]) {
      expect(shouldCacheIdentitylessForYouBootstrap(options)).toBe(false);
    }
  });

  it('bounds viewer-neutral base cache keys to supported first-page shapes', () => {
    expect(shouldCacheViewerNeutralShowcaseBasePage({ offset: 0, limit: SHOWCASE_INITIAL_PAGE_SIZE })).toBe(true);
    expect(shouldCacheViewerNeutralShowcaseBasePage({ offset: 0, limit: SHOWCASE_PAGE_SIZE })).toBe(true);
    expect(shouldCacheViewerNeutralShowcaseBasePage({ offset: 0, limit: 1 })).toBe(true);

    for (const options of [
      { offset: SHOWCASE_INITIAL_PAGE_SIZE, limit: SHOWCASE_INITIAL_PAGE_SIZE },
      { offset: 0, limit: 24 },
      { offset: 0, limit: SHOWCASE_INITIAL_PAGE_SIZE, toolSlug: 'arbitrary-tool' },
      { offset: 0, limit: SHOWCASE_INITIAL_PAGE_SIZE, bypassCache: true },
    ]) {
      expect(shouldCacheViewerNeutralShowcaseBasePage(options)).toBe(false);
    }
  });
});

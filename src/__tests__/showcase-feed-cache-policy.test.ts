import { describe, expect, it } from 'vitest';

import {
  shouldCacheIdentitylessForYouBootstrap,
  shouldCacheViewerNeutralShowcaseBasePage,
} from '@/lib/showcase-feed-cache-policy';

describe('showcase For You bootstrap cache policy', () => {
  it('caches only the identity-free first page', () => {
    const bootstrap = { sort: 'for-you' as const, offset: 0, limit: 12 };
    expect(shouldCacheIdentitylessForYouBootstrap(bootstrap)).toBe(true);

    for (const options of [
      { ...bootstrap, sort: 'recent' as const },
      { ...bootstrap, offset: 12 },
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
    expect(shouldCacheViewerNeutralShowcaseBasePage({ offset: 0, limit: 12 })).toBe(true);
    expect(shouldCacheViewerNeutralShowcaseBasePage({ offset: 0, limit: 1 })).toBe(true);

    for (const options of [
      { offset: 12, limit: 12 },
      { offset: 0, limit: 24 },
      { offset: 0, limit: 12, toolSlug: 'arbitrary-tool' },
      { offset: 0, limit: 12, bypassCache: true },
    ]) {
      expect(shouldCacheViewerNeutralShowcaseBasePage(options)).toBe(false);
    }
  });
});

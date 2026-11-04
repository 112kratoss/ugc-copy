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

describe('shared feed data-cache windows', () => {
  it('holds the identity-less For you page for no longer than one turn of its shared seed', async () => {
    const { SHOWCASE_FOR_YOU_BOOTSTRAP_REVALIDATE_SECONDS } = await import('@/lib/showcase-feed-cache-policy');
    const { FEED_SHARED_SEED_BUCKET_MS } = await import('@/lib/showcase-feed-personalization');

    expect(SHOWCASE_FOR_YOU_BOOTSTRAP_REVALIDATE_SECONDS * 1000).toBeLessThanOrEqual(FEED_SHARED_SEED_BUCKET_MS);
    expect(SHOWCASE_FOR_YOU_BOOTSTRAP_REVALIDATE_SECONDS).toBeGreaterThanOrEqual(600);
  });

  it('holds a sort lane\'s page for half an hour: its order does not decay, and content changes drop it', async () => {
    const { SHOWCASE_FEED_BASE_PAGE_REVALIDATE_SECONDS } = await import('@/lib/showcase-feed-cache-policy');

    expect(SHOWCASE_FEED_BASE_PAGE_REVALIDATE_SECONDS).toBe(1800);
  });
});

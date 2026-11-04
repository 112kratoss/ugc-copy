import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: cacheMocks.revalidateTag,
  unstable_cache: (read: unknown) => read,
}));

import { PUBLIC_PAGE_CACHE_TAG } from '@/lib/public-page-cache';
import {
  invalidateShowcaseFeedCache,
  invalidateShowcaseFeedCacheOnly,
  SHOWCASE_FEED_CACHE_TAG,
} from '@/lib/showcase-feed-cache';

describe('showcase feed cache', () => {
  beforeEach(() => {
    cacheMocks.revalidateTag.mockClear();
  });

  it('expires the shared feed tag and the cached public pages immediately', () => {
    invalidateShowcaseFeedCache();

    expect(cacheMocks.revalidateTag.mock.calls).toEqual([
      [SHOWCASE_FEED_CACHE_TAG, { expire: 0 }],
      [PUBLIC_PAGE_CACHE_TAG, { expire: 0 }],
    ]);
  });

  // A block or a report: the pages are drawn for no one and a report hides
  // nothing until a moderator decides, so every cached page stays.
  it('expires the feed tag alone for a change only the feeds show', () => {
    invalidateShowcaseFeedCacheOnly();

    expect(cacheMocks.revalidateTag.mock.calls).toEqual([
      [SHOWCASE_FEED_CACHE_TAG, { expire: 0 }],
    ]);
  });
});

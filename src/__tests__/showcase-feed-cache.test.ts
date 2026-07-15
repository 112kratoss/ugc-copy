import { describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: cacheMocks.revalidateTag,
}));

import {
  invalidateShowcaseFeedCache,
  SHOWCASE_FEED_CACHE_TAG,
} from '@/lib/showcase-feed-cache';

describe('showcase feed cache', () => {
  it('expires the shared feed tag immediately', () => {
    invalidateShowcaseFeedCache();

    expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(
      SHOWCASE_FEED_CACHE_TAG,
      { expire: 0 },
    );
  });
});

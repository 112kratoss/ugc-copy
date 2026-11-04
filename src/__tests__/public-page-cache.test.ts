import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every unstable_cache the modules below set up, by its key and options.
const cacheCalls = vi.hoisted(() => [] as Array<{
  keyParts: string[];
  options: { revalidate?: number | false; tags?: string[] };
}>);

vi.mock('next/cache', () => ({
  unstable_cache: (
    read: (...args: unknown[]) => unknown,
    keyParts: string[],
    options: { revalidate?: number | false; tags?: string[] },
  ) => {
    cacheCalls.push({ keyParts, options });
    return read;
  },
  revalidateTag: vi.fn(),
}));

// The pages' client parts make the browser's client when they are imported.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import {
  PUBLIC_PAGE_CACHE_TAG,
  PUBLIC_PAGE_REVALIDATE_SECONDS,
  cachePublicPageRead,
} from '@/lib/public-page-cache';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

function tagsOf(key: string): string[] | undefined {
  return cacheCalls.find(({ keyParts }) => keyParts[0] === key)?.options.tags;
}

describe('the cached public pages', () => {
  beforeEach(() => {
    cacheCalls.length = 0;
  });

  it("tag every read with the pages' own tag and any the page names, on the five-minute backstop", async () => {
    const read = cachePublicPageRead(async (id: string) => `read ${id}`, ['some-page-v1'], ['some-tag']);

    await expect(read('one')).resolves.toBe('read one');
    expect(cacheCalls).toEqual([{
      keyParts: ['some-page-v1'],
      options: { revalidate: PUBLIC_PAGE_REVALIDATE_SECONDS, tags: [PUBLIC_PAGE_CACHE_TAG, 'some-tag'] },
    }]);
  });

  // `invalidateShowcaseFeedCacheOnly` (a block, a report) expires the feed's
  // tag alone, so it re-renders none of them.
  it("carry their own tag, never the feed's", async () => {
    await import('@/app/showcase/[id]/page');
    await import('@/app/creators/[username]/page');
    await import('@/app/marketplace/page');

    expect(tagsOf('showcase-post-page-v1')).toEqual([PUBLIC_PAGE_CACHE_TAG]);
    expect(tagsOf('creator-page-v1')).toEqual([PUBLIC_PAGE_CACHE_TAG]);
    expect(tagsOf('marketplace-page-v1')).toEqual([PUBLIC_PAGE_CACHE_TAG, MARKETPLACE_RESOURCE_LIST_CACHE_TAG]);
    for (const key of ['showcase-post-page-v1', 'creator-page-v1', 'marketplace-page-v1']) {
      expect(tagsOf(key)).not.toContain(SHOWCASE_FEED_CACHE_TAG);
    }
  });
});

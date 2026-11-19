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

// The pages' reads, answered without a database: what is asked here is which
// tags each read carries into its page, not what it reads.
vi.mock('@/lib/public-posts', () => ({
  getPublicPostDetail: vi.fn(async () => null),
  getPostReferenceForShowcaseId: vi.fn(async () => null),
  getPublicPostMetaDescription: () => '',
}));
vi.mock('@/lib/creator-profile', () => ({
  getCreatorProfileSummary: vi.fn(async () => ({ id: 'CREATOR-1', username: 'creator-name' })),
  getCreatorProfilePageData: vi.fn(async () => ({
    profile: { id: 'CREATOR-1', username: 'creator-name', displayName: 'Creator', bio: null, avatarUrl: null, coverUrl: null },
    stats: { publicCreations: 0, totalSaves: 0, totalRemixes: 0, unlocks: 0, totalUnlockSales: 0, toolsUsed: [] },
    items: [],
    pageInfo: { hasMore: false, nextLimit: null, nextOffset: null, limit: 24, offset: 0 },
  })),
}));

import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import { CACHED_PAGE_MEDIA_SIGNATURE_SECONDS, mediaSignatureSeconds } from '@/lib/media-signature-scope';
import {
  PUBLIC_PAGE_CACHE_TAG,
  PUBLIC_PAGE_REFRESH_TAG,
  PUBLIC_PAGE_REVALIDATE_SECONDS,
  cachePublicPageRead,
  publicCreatorHandleTag,
  publicCreatorPageTag,
  publicPostArrivalTag,
  publicPostPageTag,
} from '@/lib/public-page-cache';
import { SHOWCASE_FEED_CACHE_TAG, SHOWCASE_FEED_REFRESH_TAG } from '@/lib/showcase-feed-cache';

function tagsOf(key: string): string[] | undefined {
  return cacheCalls.findLast(({ keyParts }) => keyParts[0] === key)?.options.tags;
}

const POST_ID = '0b7c2c2e-8f4e-4a59-9a3e-3c1e5f4b6d7a';

describe('the cached public pages', () => {
  beforeEach(() => {
    cacheCalls.length = 0;
  });

  it("tag every read with the removal tag, the background tag and any the page names, on the five-minute backstop", async () => {
    const read = cachePublicPageRead(async (id: string) => `read ${id}`, ['some-page-v1'], ['some-tag']);

    await expect(read('one')).resolves.toBe('read one');
    expect(cacheCalls).toEqual([{
      keyParts: ['some-page-v1'],
      options: {
        revalidate: PUBLIC_PAGE_REVALIDATE_SECONDS,
        tags: [PUBLIC_PAGE_CACHE_TAG, PUBLIC_PAGE_REFRESH_TAG, 'some-tag'],
      },
    }]);
  });

  // unstable_cache fixes its tags when it is made, and a post's tag comes
  // from the address, so a read whose tags follow its arguments is set up
  // per call; its key stays the read and the arguments.
  it('set up the cache per call for tags that follow the arguments', async () => {
    const pageRead = vi.fn(async (id: string) => `read ${id}`);
    const read = cachePublicPageRead(pageRead, ['some-page-v1'], (id) => [`page:${id}`]);
    expect(cacheCalls).toEqual([]);

    await expect(read('one')).resolves.toBe('read one');
    await expect(read('two')).resolves.toBe('read two');
    expect(cacheCalls.map(({ keyParts, options }) => [keyParts, options.tags])).toEqual([
      [['some-page-v1'], [PUBLIC_PAGE_CACHE_TAG, PUBLIC_PAGE_REFRESH_TAG, 'page:one']],
      [['some-page-v1'], [PUBLIC_PAGE_CACHE_TAG, PUBLIC_PAGE_REFRESH_TAG, 'page:two']],
    ]);
  });

  it('sign their media for longer than any cached copy of them is served', async () => {
    const read = cachePublicPageRead(async () => {
      await Promise.resolve();
      return mediaSignatureSeconds(3600);
    }, ['signing-page-v1']);

    await expect(read()).resolves.toBe(CACHED_PAGE_MEDIA_SIGNATURE_SECONDS);
    expect(mediaSignatureSeconds(3600)).toBe(3600);
  });

  it('name each page by what a write knows: a post by its id, a creator by their id, a handle as normalized', () => {
    expect(publicPostPageTag(` ${POST_ID.toUpperCase()} `)).toBe(`public-page:post:${POST_ID}`);
    expect(publicPostArrivalTag(POST_ID)).toBe(`public-page:post-arrival:${POST_ID}`);
    expect(publicCreatorPageTag('CREATOR-1')).toBe('public-page:creator:creator-1');
    expect(publicCreatorHandleTag('@Creator-Name')).toBe('public-page:creator-handle:creator-name');
    expect(publicCreatorHandleTag('  ')).toBeNull();
  });

  // `invalidateShowcaseFeedCacheOnly` (a block, a report) expires the feed's
  // tag alone and `refreshShowcaseFeedsInBackground` (the feed maintenance)
  // refreshes the feeds' own tag, so neither re-renders any of them.
  describe('carry their own tags, never the feed\'s', () => {
    it('the post page: its address\'s post and arrival tags', async () => {
      const { generateMetadata } = await import('@/app/showcase/[id]/page');
      await generateMetadata({ params: Promise.resolve({ id: POST_ID }) });

      expect(tagsOf('showcase-post-page-v2')).toEqual([
        PUBLIC_PAGE_CACHE_TAG,
        PUBLIC_PAGE_REFRESH_TAG,
        publicPostPageTag(POST_ID),
        publicPostArrivalTag(POST_ID),
      ]);
    });

    it("the creator page: its handle's lookup, then the creator the handle names", async () => {
      const { generateMetadata } = await import('@/app/creators/[username]/page');
      await generateMetadata({ params: Promise.resolve({ username: 'Creator-Name' }) });

      expect(tagsOf('creator-id-v1')).toEqual([
        PUBLIC_PAGE_CACHE_TAG,
        PUBLIC_PAGE_REFRESH_TAG,
        publicCreatorHandleTag('creator-name'),
      ]);
      expect(tagsOf('creator-page-v2')).toEqual([
        PUBLIC_PAGE_CACHE_TAG,
        PUBLIC_PAGE_REFRESH_TAG,
        publicCreatorPageTag('CREATOR-1'),
      ]);
    });

    it("the storefront: the marketplace's own tag", async () => {
      // Its read is set up once, as the module loads.
      vi.resetModules();
      await import('@/app/marketplace/page');

      expect(tagsOf('marketplace-page-v2')).toEqual([
        PUBLIC_PAGE_CACHE_TAG,
        PUBLIC_PAGE_REFRESH_TAG,
        MARKETPLACE_RESOURCE_LIST_CACHE_TAG,
      ]);
    });

    it('none of them the feed\'s', async () => {
      const { generateMetadata: postMetadata } = await import('@/app/showcase/[id]/page');
      const { generateMetadata: creatorMetadata } = await import('@/app/creators/[username]/page');
      await postMetadata({ params: Promise.resolve({ id: POST_ID }) });
      await creatorMetadata({ params: Promise.resolve({ username: 'creator-name' }) });
      await import('@/app/marketplace/page');

      for (const { options } of cacheCalls) {
        expect(options.tags).not.toContain(SHOWCASE_FEED_CACHE_TAG);
        expect(options.tags).not.toContain(SHOWCASE_FEED_REFRESH_TAG);
      }
    });
  });
});

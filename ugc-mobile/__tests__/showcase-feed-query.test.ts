import { describe, expect, it } from 'vitest';

import {
  SHOWCASE_FEED_PAGE_SIZE,
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  createShowcasePostQueryKey,
  findShowcaseFeedItemById,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedOffset,
  getShowcaseFeedPageParams,
} from '../lib/showcase-feed-query';
import type { ShowcaseFeedItem, ShowcaseFeedResponse } from '../lib/types';

function item(overrides: Partial<ShowcaseFeedItem>): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: 'Beauty hook',
    prompt: 'Launch the serum with an opening shelf shot',
    body: 'Reusable creator prompt',
    category: 'image',
    postFormat: 'media',
    saveCount: 1200,
    remixCount: 92,
    createdAt: '2026-05-13T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'luna', name: 'Luna', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

describe('showcase feed query helpers', () => {
  it('preserves default first-page params and a stable query key', () => {
    expect(SHOWCASE_FEED_PAGE_SIZE).toBe(12);
    expect(SHOWCASE_FEED_STALE_TIME_MS).toBe(5 * 60 * 1000);
    expect(getShowcaseFeedPageParams()).toEqual({
      limit: 12,
      offset: 0,
      sort: 'recent',
    });
    expect(createShowcaseFeedQueryKey()).toEqual([
      'showcase-feed',
      'infinite',
      { category: 'all', resource: 'all', sort: 'recent', tool: 'all', unlock: 'all' },
    ]);
  });

  it('flattens multiple pages in order', () => {
    const pages: ShowcaseFeedResponse[] = [
      { items: [item({ id: 'post-1' }), item({ id: 'post-2' })] },
      { items: [item({ id: 'post-3' }), item({ id: 'post-4' })] },
    ];

    expect(flattenShowcaseFeedPages(pages).map((post) => post.id)).toEqual([
      'post-1',
      'post-2',
      'post-3',
      'post-4',
    ]);
  });

  it('removes duplicate post IDs across pages', () => {
    const pages: ShowcaseFeedResponse[] = [
      { items: [item({ id: 'post-1' }), item({ id: 'post-2' })] },
      { items: [item({ id: 'post-2', title: 'Duplicate' }), item({ id: 'post-3' })] },
    ];

    expect(flattenShowcaseFeedPages(pages).map((post) => post.id)).toEqual(['post-1', 'post-2', 'post-3']);
  });

  it('finds a post inside paginated feed pages', () => {
    const pages: ShowcaseFeedResponse[] = [
      { items: [item({ id: 'post-1' }), item({ id: 'post-2' })] },
      { items: [item({ id: 'post-3', title: 'Cached detail' }), item({ id: 'post-4' })] },
    ];

    expect(findShowcaseFeedItemById(pages, 'post-3')).toMatchObject({
      id: 'post-3',
      title: 'Cached detail',
    });
  });

  it('does not find missing or empty post IDs', () => {
    expect(findShowcaseFeedItemById([{ items: [item({ id: 'post-1' })] }], 'post-2')).toBeUndefined();
    expect(findShowcaseFeedItemById(undefined, 'post-1')).toBeUndefined();
    expect(findShowcaseFeedItemById([{ items: [item({ id: 'post-1' })] }], undefined)).toBeUndefined();
  });

  it('builds detail query keys that match the viewer-specific detail query', () => {
    expect(createShowcasePostQueryKey('post-1', 'user-1')).toEqual(['showcase-post', 'post-1', 'user-1']);
    expect(createShowcasePostQueryKey('post-1', undefined)).toEqual(['showcase-post', 'post-1', undefined]);
  });

  it('returns nextOffset only while the API has more pages', () => {
    expect(
      getNextShowcaseFeedOffset({
        items: [],
        pageInfo: { hasMore: true, nextOffset: 12, limit: 12, offset: 0 },
      })
    ).toBe(12);

    expect(
      getNextShowcaseFeedOffset({
        items: [],
        pageInfo: { hasMore: false, nextOffset: 24, limit: 12, offset: 12 },
      })
    ).toBeNull();

    expect(getNextShowcaseFeedOffset({ items: [] })).toBeNull();
  });
});

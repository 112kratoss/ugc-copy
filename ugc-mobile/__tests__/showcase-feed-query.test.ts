import { describe, expect, it } from 'vitest';

import {
  SHOWCASE_FEED_PAGE_SIZE,
  SHOWCASE_FEED_STALE_TIME_MS,
  createShowcaseFeedQueryKey,
  createShowcaseFeedViewerQueryKey,
  createShowcasePostQueryKey,
  findShowcaseFeedItemById,
  flattenShowcaseFeedPages,
  getNextShowcaseFeedOffset,
  getNextShowcaseFeedPageParam,
  getShowcaseFeedPageParams,
  getShowcaseFeedSessionContext,
  normalizeShowcaseToolFilter,
  resolveMobileShowcaseFeedFilterId,
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
      sort: 'for-you',
    });
    expect(createShowcaseFeedQueryKey()).toEqual([
      'showcase-feed',
      'infinite',
      'anonymous',
      { category: 'all', resource: 'all', sort: 'for-you', tool: 'all', unlock: 'all' },
    ]);
    expect(createShowcaseFeedQueryKey({}, 'user-1')).toEqual([
      'showcase-feed',
      'infinite',
      'user-1',
      { category: 'all', resource: 'all', sort: 'for-you', tool: 'all', unlock: 'all' },
    ]);
    expect(createShowcaseFeedViewerQueryKey('user-1')).toEqual([
      'showcase-feed',
      'infinite',
      'user-1',
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

  it('serializes unlock and resource filters for the mobile feed', () => {
    expect(getShowcaseFeedPageParams({
      offset: 12,
      sort: 'top-sales',
      unlock: 'paid',
      resource: 'remix',
    })).toEqual({
      limit: 12,
      offset: 12,
      sort: 'top-sales',
      resource: 'remix',
      unlock: 'paid',
    });

    expect(createShowcaseFeedQueryKey({ unlock: 'free', resource: 'remix' })).toEqual([
      'showcase-feed',
      'infinite',
      'anonymous',
      { category: 'all', resource: 'remix', sort: 'for-you', tool: 'all', unlock: 'free' },
    ]);
  });

  it('normalizes mobile feed filter route params', () => {
    expect(resolveMobileShowcaseFeedFilterId('unlocks')).toBe('unlocks');
    expect(resolveMobileShowcaseFeedFilterId(['paid', 'free'])).toBe('paid');
    expect(resolveMobileShowcaseFeedFilterId('missing')).toBe('all');
    expect(resolveMobileShowcaseFeedFilterId(undefined)).toBe('all');
    expect(normalizeShowcaseToolFilter('runway')).toBe('runway');
    expect(normalizeShowcaseToolFilter([' midjourney ', 'ignored'])).toBe('midjourney');
    expect(normalizeShowcaseToolFilter('all')).toBeNull();
    expect(normalizeShowcaseToolFilter('')).toBeNull();
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

  it('continues ranked feeds with an opaque cursor and session while retaining offset fallback', () => {
    const rankedPage: ShowcaseFeedResponse = {
      items: [],
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
      nextCursor: 'opaque-cursor',
      pageInfo: { hasMore: true, nextOffset: 12 },
    };

    expect(getNextShowcaseFeedPageParam(rankedPage)).toEqual({
      cursor: 'opaque-cursor',
      feedSessionId: 'session-1',
    });
    expect(getShowcaseFeedPageParams({
      cursor: 'opaque-cursor',
      feedSessionId: 'session-1',
    })).toEqual({
      limit: 12,
      sort: 'for-you',
      cursor: 'opaque-cursor',
      feedSessionId: 'session-1',
    });
    expect(getNextShowcaseFeedPageParam({
      items: [],
      pageInfo: { hasMore: true, nextOffset: 24 },
    })).toEqual({ offset: 24 });
  });

  it('reads stable session metadata from paginated ranked responses', () => {
    expect(getShowcaseFeedSessionContext([
      { items: [], feedSessionId: 'session-1', algorithmVersion: 'hybrid-v1' },
      { items: [], feedSessionId: 'session-1', nextCursor: null },
    ])).toEqual({
      feedSessionId: 'session-1',
      algorithmVersion: 'hybrid-v1',
    });
  });
});

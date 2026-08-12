import { beforeEach, describe, expect, it } from 'vitest';

import {
  SHOWCASE_CLIENT_CACHE_TTL_MS,
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  readShowcaseClientSnapshot,
  writeShowcaseClientSnapshot,
  SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS,
} from '@/lib/showcase-client-cache';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

const feed: ShowcaseFeedPage = {
  items: [],
  pageInfo: {
    hasMore: false,
    nextOffset: null,
    limit: 12,
    offset: 0,
  },
  feedSessionId: 'feed-session-1',
};

function buildKey(viewerId: string | null = null) {
  return buildShowcaseClientCacheKey({
    viewerId,
    category: 'all',
    sort: 'for-you',
    tool: null,
    unlock: 'all',
    resource: 'all',
  });
}

function cacheItem(index: number): ShowcaseFeedItem {
  return { id: `post-${index}` } as ShowcaseFeedItem;
}

describe('showcase client cache', () => {
  beforeEach(() => {
    clearShowcaseClientCacheForTests();
  });

  it('keeps anonymous and signed-in feed snapshots isolated', () => {
    expect(buildKey(null)).not.toBe(buildKey('user-1'));
  });

  it('restores feed, render, and save state during the freshness window', () => {
    const cacheKey = buildKey('user-1');
    writeShowcaseClientSnapshot(cacheKey, {
      feed,
      renderedItemCount: 8,
      savedItemIds: ['post-1'],
    }, 1_000);

    expect(readShowcaseClientSnapshot(cacheKey, 2_000)).toMatchObject({
      feed,
      renderedItemCount: 8,
      savedItemIds: ['post-1'],
      cachedAt: 1_000,
    });
  });

  it('drops stale route snapshots instead of showing an old personalized feed', () => {
    const cacheKey = buildKey('user-1');
    writeShowcaseClientSnapshot(cacheKey, {
      feed,
      renderedItemCount: 4,
      savedItemIds: [],
    }, 1_000);

    expect(readShowcaseClientSnapshot(
      cacheKey,
      1_000 + SHOWCASE_CLIENT_CACHE_TTL_MS + 1
    )).toBeNull();
  });

  it('caps pure offset snapshots and rewrites their continuation', () => {
    const cacheKey = buildKey('user-1');
    const items = Array.from({ length: 48 }, (_, index) => cacheItem(index));
    const snapshot = writeShowcaseClientSnapshot(cacheKey, {
      feed: {
        ...feed,
        items,
        pageInfo: { ...feed.pageInfo, hasMore: true, nextOffset: 48, nextCursor: null },
      },
      renderedItemCount: 48,
      savedItemIds: [],
    });

    expect(snapshot.feed.items).toHaveLength(SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS);
    expect(snapshot.feed.items[0]?.id).toBe('post-0');
    expect(snapshot.feed.items.at(-1)?.id).toBe('post-35');
    expect(snapshot.feed.pageInfo.nextOffset).toBe(SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS);
    expect(snapshot.feed.pageInfo.hasMore).toBe(true);
    expect(snapshot.renderedItemCount).toBe(SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS);
  });

  it('does not truncate cursor snapshots', () => {
    const cacheKey = buildKey('user-1');
    const items = Array.from({ length: 48 }, (_, index) => cacheItem(index));
    const snapshot = writeShowcaseClientSnapshot(cacheKey, {
      feed: {
        ...feed,
        items,
        pageInfo: { ...feed.pageInfo, hasMore: true, nextOffset: null, nextCursor: 'cursor-48' },
      },
      renderedItemCount: 48,
      savedItemIds: [],
    });

    expect(snapshot.feed.items).toHaveLength(48);
    expect(snapshot.feed.pageInfo.nextCursor).toBe('cursor-48');
  });

  it('leaves an exactly capped offset snapshot untouched', () => {
    const cacheKey = buildKey('user-1');
    const items = Array.from(
      { length: SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS },
      (_, index) => cacheItem(index)
    );
    const snapshot = writeShowcaseClientSnapshot(cacheKey, {
      feed: {
        ...feed,
        items,
        pageInfo: {
          ...feed.pageInfo,
          hasMore: true,
          nextOffset: SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS,
          nextCursor: null,
        },
      },
      renderedItemCount: SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS,
      savedItemIds: [],
    });

    expect(snapshot.feed.items).toHaveLength(SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS);
    expect(snapshot.feed.pageInfo.nextOffset).toBe(SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS);
  });
});

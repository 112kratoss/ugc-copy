import { beforeEach, describe, expect, it } from 'vitest';

import {
  SHOWCASE_CLIENT_CACHE_TTL_MS,
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  readShowcaseClientSnapshot,
  getCreatorsBlockedThisVisit,
  takeBlockedCreatorOffClientFeeds,
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

  // A creator can be blocked away from the pages that keep a snapshot: on
  // their own page, or from saved posts. Coming back to Explore or the home
  // feed afterwards restored the copy kept from before, with their posts in it.
  describe('after a block', () => {
    const postBy = (id: string, creatorId: string) => ({ id, creator: { id: creatorId } }) as ShowcaseFeedItem;
    const storedSnapshot = (cacheKey: string) => {
      const storageKey = Object.keys(window.sessionStorage).find((key) => key.endsWith(cacheKey));
      return storageKey ? JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') : null;
    };
    const ids = (snapshot: { feed: { items: Array<{ id: string }> } } | null) => snapshot?.feed.items.map((item) => item.id);

    it("takes the creator's posts out of every snapshot, in memory and in storage, and keeps the rest as it was", () => {
      const gridKey = buildKey('user-1');
      const homeKey = buildShowcaseClientCacheKey({
        surface: 'home-feed',
        viewerId: 'user-1',
        category: 'all',
        sort: 'for-you',
        tool: null,
        unlock: 'all',
        resource: 'all',
      });
      const untouchedKey = buildKey('user-2');
      const now = Date.now();
      writeShowcaseClientSnapshot(gridKey, {
        feed: { ...feed, items: [postBy('a-1', 'creator-a'), postBy('b-1', 'creator-b'), postBy('a-2', 'creator-a')] },
        renderedItemCount: 3,
        savedItemIds: ['a-1'],
      }, now - 5_000);
      writeShowcaseClientSnapshot(homeKey, {
        feed: { ...feed, items: [postBy('a-3', 'creator-a'), postBy('c-1', 'creator-c')] },
        renderedItemCount: 1,
        savedItemIds: [],
      }, now - 4_000);
      writeShowcaseClientSnapshot(untouchedKey, {
        feed: { ...feed, items: [postBy('b-2', 'creator-b')] },
        renderedItemCount: 1,
        savedItemIds: [],
      }, now - 3_000);
      const untouchedBefore = JSON.stringify(storedSnapshot(untouchedKey));

      takeBlockedCreatorOffClientFeeds('creator-a');

      const grid = readShowcaseClientSnapshot(gridKey);
      expect(ids(grid)).toEqual(['b-1']);
      // No more is drawn than is left, and the snapshot is no younger for it.
      expect(grid?.renderedItemCount).toBe(1);
      expect(grid?.cachedAt).toBe(now - 5_000);
      expect(grid?.feed.pageInfo).toEqual(feed.pageInfo);
      expect(ids(readShowcaseClientSnapshot(homeKey))).toEqual(['c-1']);
      // A page loaded afresh reads storage, not this tab's memory.
      expect(ids(storedSnapshot(gridKey))).toEqual(['b-1']);
      expect(ids(storedSnapshot(homeKey))).toEqual(['c-1']);
      expect(JSON.stringify(storedSnapshot(untouchedKey))).toBe(untouchedBefore);
    });

    it('reads a snapshot that only storage holds, and leaves alone a post with no creator', () => {
      const cacheKey = buildKey('user-1');
      const now = Date.now();
      writeShowcaseClientSnapshot(cacheKey, {
        feed: { ...feed, items: [postBy('a-1', 'creator-a'), cacheItem(7)] },
        renderedItemCount: 2,
        savedItemIds: [],
      }, now);
      // As after a reload: storage holds the snapshot and memory is empty.
      const storageKey = Object.keys(window.sessionStorage).find((key) => key.endsWith(cacheKey))!;
      const serialized = window.sessionStorage.getItem(storageKey)!;
      clearShowcaseClientCacheForTests();
      window.sessionStorage.setItem(storageKey, serialized);

      takeBlockedCreatorOffClientFeeds('creator-a');

      expect(ids(storedSnapshot(cacheKey))).toEqual(['post-7']);
      expect(ids(readShowcaseClientSnapshot(cacheKey))).toEqual(['post-7']);
    });

    // Explore's first page is the server's for everyone, so it asks who was
    // blocked since the tab loaded before it draws.
    it('remembers the creator for the rest of the visit', () => {
      expect([...getCreatorsBlockedThisVisit()]).toEqual([]);

      takeBlockedCreatorOffClientFeeds('creator-a');
      takeBlockedCreatorOffClientFeeds('creator-b');
      takeBlockedCreatorOffClientFeeds('creator-a');

      expect([...getCreatorsBlockedThisVisit()]).toEqual(['creator-a', 'creator-b']);
    });
  });
});

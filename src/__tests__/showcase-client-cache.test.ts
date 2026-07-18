import { beforeEach, describe, expect, it } from 'vitest';

import {
  SHOWCASE_CLIENT_CACHE_TTL_MS,
  buildShowcaseClientCacheKey,
  clearShowcaseClientCacheForTests,
  readShowcaseClientSnapshot,
  writeShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import type { ShowcaseFeedPage } from '@/lib/showcase';

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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PreparedRankedFeedSession } from '@/lib/showcase-feed-personalization';

// Next's data cache as Vercel shares it between a function's instances: one
// store keyed by the cached function's key parts and arguments. A miss runs
// the function and keeps what it returns.
const dataCache = vi.hoisted(() => ({ entries: new Map<string, unknown>(), available: true }));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => Promise<unknown>, keyParts: string[]) => (
    async (...args: unknown[]) => {
      if (!dataCache.available) throw new Error('Invariant: incrementalCache missing in unstable_cache');
      const key = `${keyParts.join(',')}-${JSON.stringify(args)}`;
      if (dataCache.entries.has(key)) return JSON.parse(JSON.stringify(dataCache.entries.get(key)));
      const value = await fn(...args);
      dataCache.entries.set(key, value);
      return value;
    }
  ),
}));

const NOW = Date.parse('2026-11-04T06:00:00.000Z');

function prepared(overrides: Partial<PreparedRankedFeedSession> = {}): PreparedRankedFeedSession {
  return {
    format: 1,
    preparedAt: NOW,
    viewerUserId: 'viewer-1',
    anonymousKeyHash: null,
    filters: { category: 'media', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
    algorithmId: 'algorithm-v4',
    algorithmVersion: 'for-you-rules-v4',
    candidateRpc: 'v4',
    visibilityThresholds: { recommendationMaxPostNegativeRisk: 1, recommendationMaxCreatorNegativeRate: 1 },
    experimentAssignmentId: null,
    experimentId: null,
    experimentVariantId: null,
    randomSeed: 42,
    ranked: [],
    ...overrides,
  };
}

async function loadStore() {
  return import('@/lib/showcase-feed-read-ahead');
}

describe('showcase feed read-ahead store', () => {
  beforeEach(async () => {
    dataCache.entries.clear();
    dataCache.available = true;
    (await loadStore()).resetShowcaseFeedReadAheadStoreForTests();
  });

  it('answers a fresh random token and hands its ranking out once', async () => {
    const store = await loadStore();
    const ranking = prepared();

    const { token, expiresInMs } = await store.storePreparedShowcaseFeedSession(ranking, { now: () => NOW });

    expect(store.isShowcaseFeedReadAheadToken(token)).toBe(true);
    expect(expiresInMs).toBe(2 * 60 * 1000);
    const claim = { anonymousKeyHash: null, viewerUserId: 'viewer-1', now: () => NOW + 30_000 };
    await expect(store.takePreparedShowcaseFeedSession(token, claim)).resolves.toEqual(ranking);
    await expect(store.takePreparedShowcaseFeedSession(token, claim)).resolves.toBeNull();
  });

  it("serves a claim that lands on another of the function's instances from the shared data cache", async () => {
    const store = await loadStore();
    const ranking = prepared();
    const { token } = await store.storePreparedShowcaseFeedSession(ranking, { now: () => NOW });

    // Another instance: nothing of this one's memory.
    store.resetShowcaseFeedReadAheadStoreForTests();

    await expect(store.takePreparedShowcaseFeedSession(token, {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-1',
      now: () => NOW + 30_000,
    })).resolves.toEqual(ranking);
  });

  it('hands nothing out past its time, to another viewer, or for a token it never issued', async () => {
    const store = await loadStore();
    const late = await store.storePreparedShowcaseFeedSession(prepared(), { now: () => NOW });
    const stranger = await store.storePreparedShowcaseFeedSession(prepared(), { now: () => NOW });

    await expect(store.takePreparedShowcaseFeedSession(late.token, {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-1',
      now: () => NOW + 2 * 60 * 1000 + 1,
    })).resolves.toBeNull();
    await expect(store.takePreparedShowcaseFeedSession(stranger.token, {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-2',
      now: () => NOW,
    })).resolves.toBeNull();
    await expect(store.takePreparedShowcaseFeedSession('0f8b6c7e-4a1d-4c2b-9e3f-5a6b7c8d9e0f', {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-1',
      now: () => NOW,
    })).resolves.toBeNull();
    await expect(store.takePreparedShowcaseFeedSession('not-a-token', {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-1',
      now: () => NOW,
    })).resolves.toBeNull();
  });

  it("holds at most fifty whole rankings in an instance's memory, dropping the oldest first", async () => {
    dataCache.available = false;
    const store = await loadStore();
    expect(store.SHOWCASE_FEED_READ_AHEAD_LOCAL_LIMIT).toBe(50);
    const tokens: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      tokens.push((await store.storePreparedShowcaseFeedSession(prepared(), { now: () => NOW })).token);
    }
    const claim = { anonymousKeyHash: null, viewerUserId: 'viewer-1', now: () => NOW };

    await expect(store.takePreparedShowcaseFeedSession(tokens[0], claim)).resolves.toBeNull();
    await expect(store.takePreparedShowcaseFeedSession(tokens[1], claim)).resolves.not.toBeNull();
    await expect(store.takePreparedShowcaseFeedSession(tokens[50], claim)).resolves.not.toBeNull();
  });

  it('keeps working on this instance alone where there is no data cache', async () => {
    dataCache.available = false;
    const store = await loadStore();
    const ranking = prepared();

    const { token } = await store.storePreparedShowcaseFeedSession(ranking, { now: () => NOW });

    await expect(store.takePreparedShowcaseFeedSession(token, {
      anonymousKeyHash: null,
      viewerUserId: 'viewer-1',
      now: () => NOW,
    })).resolves.toEqual(ranking);
  });
});

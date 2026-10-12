import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getPersonalizedShowcaseFeedPage,
  normalizeRetrievalConfig,
} from '@/lib/showcase-feed-personalization';
import {
  FOR_YOU_RULES_V3_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V3_WEIGHTS,
  FOR_YOU_RULES_V4_DIVERSITY_CONFIG,
  FOR_YOU_RULES_V4_RETRIEVAL_CONFIG,
  FOR_YOU_RULES_V4_WEIGHTS,
  decodeRankedFeedCursor,
  encodeRankedFeedCursor,
  explainRankedFeedScore,
  type RankedShowcaseItem,
} from '@/lib/showcase-feed-ranking';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const loggerMocks = vi.hoisted(() => ({ logBackendError: vi.fn() }));

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-logger')>()),
  logBackendError: loggerMocks.logBackendError,
}));

function item(id: string): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://example.com/${id}.jpg`,
    mediaKind: 'image',
    model: 'manual',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-07-11T05:00:00.000Z',
    creator: { id: `creator-${id}`, username: id, name: id, avatar: null },
    sourceKind: 'manual',
    sourceTool: null,
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

function serviceClient(featurePostIds: string[]) {
  const rpc = vi.fn(async () => ({
    data: featurePostIds.map((postId) => ({
      post_id: postId,
      interest_match: 0.8,
      creator_affinity: 0,
      smoothed_usefulness: 0.2,
      freshness: 0.8,
      relevant_trend: 0,
      exploration_bonus: 0.1,
      quick_skip_risk: 0,
      negative_feedback_risk: 0,
      candidate_source: 'interest',
    })),
    error: null,
  }));
  const algorithmQuery = {
    select: () => algorithmQuery,
    eq: () => algorithmQuery,
    maybeSingle: async () => ({
      data: {
        id: 'algorithm-1',
        algorithm_key: 'for-you-rules',
        version: 3,
        weights: {},
        retrieval_config: { candidate_limit: 300, session_item_limit: 60 },
        diversity_config: {},
      },
      error: null,
    }),
  };
  return { rpc, from: vi.fn(() => algorithmQuery) } as unknown as SupabaseClient;
}

describe('showcase feed personalization candidate filling', () => {
  it('retrieves a broad candidate pool for media filtering instead of querying a nonexistent media category', async () => {
    const db = serviceClient(['image', 'video']);
    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null, cursor: null,
      filters: { category: 'media', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: async (ids) => ids.map((id) => item(id)),
      fallbackItems: async () => [],
      limit: 12, offset: 0, serviceClient: db, viewerUserId: null,
    });
    expect(db.rpc).toHaveBeenCalledWith('get_ranked_feed_candidates', expect.objectContaining({ p_category: null }));
    expect(page.items).toHaveLength(2);
  });

  it('uses filtered fallback inventory when RPC candidates are removed during hydration', async () => {
    const hydratePostIds = vi.fn(async () => [] as ShowcaseFeedItem[]);
    const fallbackItems = vi.fn(async () => [item('tool-match-1'), item('tool-match-2')]);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: 'selected-tool', unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: serviceClient(['unrelated-1', 'unrelated-2']),
      viewerUserId: null,
    });

    expect(hydratePostIds).toHaveBeenCalledWith(['unrelated-1', 'unrelated-2']);
    expect(fallbackItems).toHaveBeenCalledTimes(1);
    expect(page.items.map((entry) => entry.id).sort()).toEqual(['tool-match-1', 'tool-match-2']);
  });

  it('merges and de-duplicates fallback candidates when only part of the RPC pool survives filters', async () => {
    const primary = item('matching-ranked');
    const hydratePostIds = vi.fn(async () => [primary]);
    const fallbackItems = vi.fn(async () => [primary, item('matching-recent')]);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'with-unlock', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: serviceClient(['matching-ranked', 'filtered-out']),
      viewerUserId: null,
    });

    expect(fallbackItems).toHaveBeenCalledTimes(1);
    expect(page.items.map((entry) => entry.id).sort()).toEqual(['matching-ranked', 'matching-recent']);
  });

  it('keeps a 300-row lightweight pool but stops rich hydration after 60 eligible posts', async () => {
    const postIds = Array.from({ length: 300 }, (_, index) => `candidate-${index}`);
    const hydratePostIds = vi.fn(async (ids: string[]) => ids.map((id) => item(id)));
    const fallbackItems = vi.fn(async () => [] as ShowcaseFeedItem[]);
    const db = serviceClient(postIds);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: db,
      viewerUserId: null,
    });

    expect(db.rpc).toHaveBeenCalledWith('get_ranked_feed_candidates', expect.objectContaining({ p_limit: 300 }));
    expect(hydratePostIds).toHaveBeenCalledTimes(1);
    expect(hydratePostIds.mock.calls[0]?.[0]).toHaveLength(60);
    expect(fallbackItems).not.toHaveBeenCalled();
    expect(page.items).toHaveLength(12);
    // 60 ranked candidates against a 12-item page: there is more, and saying so does
    // not depend on having opened a session.
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextOffset).toBe(12);
    expect(page.pageInfo.nextCursor).toBeNull();
  });

  it('still reports more pages when no session could be persisted', async () => {
    // The signed-out home page renders without request headers so it stays
    // statically cacheable, which leaves it with no anonymous key and therefore no
    // persisted session. It must still be able to page, or the feed dead-ends at
    // one page for every logged-out visitor.
    const postIds = Array.from({ length: 40 }, (_, index) => `candidate-${index}`);
    const hydratePostIds = vi.fn(async (ids: string[]) => ids.map((id) => item(id)));
    const fallbackItems = vi.fn(async () => [] as ShowcaseFeedItem[]);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: serviceClient(postIds),
      viewerUserId: null,
    });

    expect(page.feedSessionId).toBeNull();
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.pageInfo.nextOffset).toBe(12);
    // A cursor would promise to resume this exact ranking, which an unpersisted
    // session cannot do — so it stays null and the client pages by offset.
    expect(page.pageInfo.nextCursor).toBeNull();
  });

  it('reports no more pages once the ranked pool is exhausted', async () => {
    const postIds = Array.from({ length: 8 }, (_, index) => `candidate-${index}`);
    const hydratePostIds = vi.fn(async (ids: string[]) => ids.map((id) => item(id)));
    const fallbackItems = vi.fn(async () => [] as ShowcaseFeedItem[]);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: serviceClient(postIds),
      viewerUserId: null,
    });

    expect(page.items).toHaveLength(8);
    expect(page.pageInfo.hasMore).toBe(false);
    expect(page.pageInfo.nextOffset).toBeNull();
  });

  it('uses active retrieval limits and weights before deciding which candidates to hydrate', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          post_id: 'interest-first-from-rpc', interest_match: 1, freshness: 0,
          candidate_source: 'interest',
        },
        {
          post_id: 'fresh-from-config', interest_match: 0, freshness: 1,
          candidate_source: 'recent',
        },
      ],
      error: null,
    }));
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data: {
          id: 'algorithm-9',
          algorithm_key: 'for-you-rules',
          version: 9,
          weights: {
            interest_match: 0,
            creator_affinity: 0,
            smoothed_usefulness: 0,
            freshness: 1,
            relevant_trend: 0,
            exploration_bonus: 0,
            quick_skip_risk: 0,
            negative_feedback_risk: 0,
          },
          retrieval_config: { candidate_limit: 2, session_item_limit: 1 },
          diversity_config: { max_creator_per_20: 2 },
        },
        error: null,
      }),
    };
    const db = { rpc, from: vi.fn(() => query) } as unknown as SupabaseClient;
    const hydratePostIds = vi.fn(async (ids: string[]) => ids.map((id) => item(id)));

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems: vi.fn(),
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 1,
      offset: 0,
      serviceClient: db,
      viewerUserId: null,
    });

    expect(rpc).toHaveBeenCalledWith('get_ranked_feed_candidates', expect.objectContaining({ p_limit: 2 }));
    expect(hydratePostIds).toHaveBeenCalledWith(['fresh-from-config']);
    expect(page.items.map((entry) => entry.id)).toEqual(['fresh-from-config']);
    expect(page.algorithmVersion).toBe('for-you-rules-v9');
  });

  it('returns a coherent non-paginating recent fallback when no algorithm is active', async () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const db = { rpc: vi.fn(), from: vi.fn(() => query) } as unknown as SupabaseClient;
    const fallbackItems = vi.fn(async () => [item('recent-1'), item('recent-2')]);

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: vi.fn(),
      limit: 1,
      offset: 0,
      serviceClient: db,
      viewerUserId: null,
    });

    expect(db.rpc).not.toHaveBeenCalled();
    expect(page.items.map((entry) => entry.id)).toEqual(['recent-1']);
    expect(page.feedSessionId).toBeNull();
    expect(page.algorithmVersion).toBe('recent-fallback-v1');
    expect(page.pageInfo).toMatchObject({ hasMore: false, nextCursor: null, nextOffset: null });
  });

  it('fails a malformed continuation cursor closed without creating a replacement session', async () => {
    const db = { rpc: vi.fn(), from: vi.fn() } as unknown as SupabaseClient;
    const fallbackItems = vi.fn();

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: 'a'.repeat(64),
      cursor: 'malformed',
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: vi.fn(),
      limit: 12,
      offset: 12,
      serviceClient: db,
      viewerUserId: null,
    });

    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fallbackItems).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasMore: false, nextCursor: null, nextOffset: null });
  });

  it('fails an expired continuation cursor closed without running a new ranking', async () => {
    const sessionQuery = {
      select: () => sessionQuery,
      eq: () => sessionQuery,
      maybeSingle: async () => ({
        data: {
          id: 'expired-session',
          viewer_user_id: null,
          anonymous_key_hash: 'a'.repeat(64),
          algorithm_version_id: 'algorithm-1',
          created_at: '2026-07-01T00:00:00.000Z',
          expires_at: '2026-07-02T00:00:00.000Z',
        },
        error: null,
      }),
    };
    const db = {
      rpc: vi.fn(),
      from: vi.fn(() => sessionQuery),
    } as unknown as SupabaseClient;
    const fallbackItems = vi.fn();

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: 'a'.repeat(64),
      cursor: encodeRankedFeedCursor({ sessionId: 'expired-session', position: 12 }),
      fallbackItems,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: vi.fn(),
      limit: 12,
      offset: 12,
      serviceClient: db,
      viewerUserId: null,
    });

    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(fallbackItems).not.toHaveBeenCalled();
    expect(page.items).toEqual([]);
    expect(page.pageInfo.hasMore).toBe(false);
  });

  it.each([
    { name: 'matching scope', candidateAlgorithm: 'algorithm-7', candidateAssignment: null, reads: 1 },
    { name: 'newer different algorithm', candidateAlgorithm: 'algorithm-old', candidateAssignment: null, reads: 2 },
    { name: 'newer experiment assignment', candidateAlgorithm: 'algorithm-7', candidateAssignment: 44, reads: 2 },
    { name: 'missing experiment scope', candidateAlgorithm: 'algorithm-7', candidateAssignment: undefined, reads: 2 },
  ])('overlaps session lookup and reuses the correct session: $name', async ({
    candidateAlgorithm, candidateAssignment, reads,
  }) => {
    const anonymousKeyHash = 'b'.repeat(64);
    const activeAlgorithm = {
      id: 'algorithm-7',
      algorithm_key: 'for-you-rules',
      version: 7,
      weights: {},
      retrieval_config: { candidate_limit: 300, session_item_limit: 60 },
      diversity_config: {},
    };
    const insertCalls: ReturnType<typeof vi.fn>[] = [];
    const eqCalls: Array<[string, unknown]> = [];
    const isCalls: Array<[string, unknown]> = [];
    const containsCalls: Array<[string, unknown]> = [];
    const selectCalls: string[] = [];
    const updateCalls: unknown[] = [];
    const fluent = (options: { maybeSingleData?: unknown; awaitedData?: unknown }) => {
      const query: Record<string, unknown> = {};
      for (const method of ['in', 'gt', 'gte', 'lt', 'order', 'limit', 'delete']) {
        query[method] = vi.fn(() => query);
      }
      query.update = vi.fn((value: unknown) => {
        updateCalls.push(value);
        return query;
      });
      query.select = vi.fn((columns: string) => {
        selectCalls.push(columns);
        return query;
      });
      query.is = vi.fn((field: string, value: unknown) => {
        isCalls.push([field, value]);
        return query;
      });
      query.contains = vi.fn((field: string, value: unknown) => {
        containsCalls.push([field, value]);
        return query;
      });
      query.eq = vi.fn((field: string, value: unknown) => {
        eqCalls.push([field, value]);
        return query;
      });
      const insert = vi.fn(() => query);
      insertCalls.push(insert);
      query.insert = insert;
      query.maybeSingle = vi.fn(async () => ({ data: options.maybeSingleData ?? null, error: null }));
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: options.awaitedData ?? null, error: null }).then(resolve, reject);
      return query;
    };
    let algorithmReads = 0;
    let sessionReads = 0;
    let sessionItemReads = 0;
    let releaseAlgorithm!: () => void;
    const algorithmReady = new Promise<void>((resolve) => { releaseAlgorithm = resolve; });
    const from = vi.fn((table: string) => {
      if (table === 'feed_algorithm_versions') {
        algorithmReads += 1;
        const query = fluent({ maybeSingleData: activeAlgorithm });
        query.maybeSingle = async () => {
          await algorithmReady;
          return { data: activeAlgorithm, error: null };
        };
        return query;
      }
      if (table === 'feed_sessions') {
        sessionReads += 1;
        if (sessionReads <= reads) return fluent({
          maybeSingleData: {
            id: sessionReads === 1 && reads === 2 ? 'session-other-scope' : 'session-reused',
            viewer_user_id: null,
            anonymous_key_hash: anonymousKeyHash,
            algorithm_version_id: sessionReads === 1 ? candidateAlgorithm : 'algorithm-7',
            experiment_assignment_id: sessionReads === 1 ? candidateAssignment : null,
            created_at: new Date().toISOString(),
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        });
        return fluent({ awaitedData: [] });
      }
      if (table === 'feed_session_items') {
        sessionItemReads += 1;
        return sessionItemReads === 1
          ? fluent({
            awaitedData: [{
              id: 9001,
              post_id: 'persisted-post',
              position: 0,
              candidate_source: 'interest',
              final_score: 0.9,
              score_components: { interest_match: 1 },
            }],
          })
          : fluent({ awaitedData: [] });
      }
      if (table === 'feed_delivery_facts') {
        return fluent({ awaitedData: [] });
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const db = { rpc: vi.fn(), from } as unknown as SupabaseClient;
    const hydratePostIds = vi.fn(async () => [item('persisted-post')]);

    const pendingPage = getPersonalizedShowcaseFeedPage({
      anonymousKeyHash,
      cursor: null,
      fallbackItems: vi.fn(),
      filters: { category: 'all', toolSlug: 'video-tool', unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 12,
      offset: 0,
      serviceClient: db,
      viewerUserId: null,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The bounded session read must start before algorithm resolution ends.
      expect(sessionReads).toBe(1);
    } finally {
      releaseAlgorithm();
    }
    const page = await pendingPage;

    expect(algorithmReads).toBe(1);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(insertCalls.every((insert) => insert.mock.calls.length === 0)).toBe(true);
    expect(updateCalls).toEqual([]);
    expect(containsCalls).toContainEqual(['filters', {
      category: 'all', toolSlug: 'video-tool', unlockFilter: 'all', resourceFilter: 'all',
    }]);
    expect(selectCalls).toContain(
      'id, viewer_user_id, anonymous_key_hash, algorithm_version_id, experiment_assignment_id, created_at, expires_at',
    );
    expect(sessionReads).toBe(reads);
    if (reads === 2) {
      expect(eqCalls).toContainEqual(['algorithm_version_id', 'algorithm-7']);
      expect(isCalls).toContainEqual(['experiment_assignment_id', null]);
    }
    expect(isCalls).toContainEqual(['viewer_user_id', null]);
    expect(eqCalls).toContainEqual(['anonymous_key_hash', anonymousKeyHash]);
    expect(hydratePostIds).toHaveBeenCalledWith(['persisted-post']);
    expect(page.feedSessionId).toBe('session-reused');
    expect(page.algorithmVersion).toBe('for-you-rules-v7');
    expect(page.items[0]?.recommendation).toMatchObject({
      deliveryId: '9001', algorithmVersion: 'for-you-rules-v7', position: 0,
    });
  });

  it('scans across deleted, hidden, and position-gapped session rows without misattributing deliveries', async () => {
    const rows = [
      { id: 100, post_id: 'deleted', position: 0 },
      { id: 102, post_id: 'visible-a', position: 2 },
      { id: 105, post_id: 'hidden-post', position: 5 },
      { id: 107, post_id: 'hidden-creator', position: 7 },
      { id: 109, post_id: 'visible-b', position: 9 },
      { id: 112, post_id: 'visible-c', position: 12 },
    ].map((row) => ({
      ...row,
      candidate_source: 'interest',
      final_score: 0.8,
      score_components: { interest_match: 0.8 },
    }));
    const servedIds: Array<string | number> = [];
    const fluent = ({
      awaitedData = [],
      maybeSingleData = null,
      captureServedIds = false,
    }: {
      awaitedData?: unknown;
      maybeSingleData?: unknown;
      captureServedIds?: boolean;
    }) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'gte', 'order', 'limit', 'update', 'is']) {
        query[method] = vi.fn(() => query);
      }
      query.in = vi.fn((_field: string, values: Array<string | number>) => {
        if (captureServedIds) servedIds.push(...values);
        return query;
      });
      query.maybeSingle = vi.fn(async () => ({ data: maybeSingleData, error: null }));
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: awaitedData, error: null }).then(resolve, reject);
      return query;
    };
    let sessionReads = 0;
    let sessionItemReads = 0;
    const from = vi.fn((table: string) => {
      if (table === 'feed_sessions') {
        sessionReads += 1;
        return sessionReads === 1
          ? fluent({
            maybeSingleData: {
              id: 'gap-session',
              viewer_user_id: 'viewer-1',
              anonymous_key_hash: null,
              algorithm_version_id: 'algorithm-1',
              created_at: '2026-07-11T05:00:00.000Z',
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          })
          : fluent({});
      }
      if (table === 'feed_algorithm_versions') {
        return fluent({
          maybeSingleData: {
            id: 'algorithm-1',
            algorithm_key: 'for-you-rules',
            version: 1,
            weights: {},
            retrieval_config: { candidate_limit: 300, session_item_limit: 60 },
            diversity_config: {},
          },
        });
      }
      if (table === 'feed_session_items') {
        sessionItemReads += 1;
        return sessionItemReads === 1
          ? fluent({ awaitedData: rows })
          : fluent({ captureServedIds: true });
      }
      if (table === 'feed_user_post_feedback') {
        return fluent({ awaitedData: [{ post_id: 'hidden-post' }] });
      }
      if (table === 'feed_user_creator_feedback') {
        return fluent({ awaitedData: [{ creator_user_id: 'creator-hidden-creator' }] });
      }
      if (table === 'feed_delivery_facts' || table === 'user_blocks' || table === 'post_reports') {
        return fluent({ awaitedData: [] });
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const hydratePostIds = vi.fn(async (ids: string[]) => (
      ids.filter((id) => id !== 'deleted').map((id) => item(id))
    ));

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: encodeRankedFeedCursor({ sessionId: 'gap-session', position: 1 }),
      fallbackItems: vi.fn(),
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds,
      limit: 2,
      offset: 0,
      serviceClient: { from, rpc: vi.fn() } as unknown as SupabaseClient,
      viewerUserId: 'viewer-1',
    });

    expect(page.items.map((entry) => entry.id)).toEqual(['visible-a', 'visible-b']);
    expect(page.items.map((entry) => entry.recommendation)).toMatchObject([
      { deliveryId: '102', position: 2 },
      { deliveryId: '109', position: 9 },
    ]);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeRankedFeedCursor(page.pageInfo.nextCursor)).toEqual({
      sessionId: 'gap-session',
      position: 10,
    });
    expect(servedIds).toEqual([102, 109]);
  });

  it('keeps experiment attribution, reuse scope, and deterministic propensity on delivery facts', async () => {
    let persistencePayload: Record<string, unknown> | null = null;
    const sessionEqCalls: Array<[string, unknown]> = [];
    let sessionReads = 0;

    const fluent = ({
      awaitedData = null,
      maybeSingleData = null,
      singleData = null,
      onInsert,
      onEq,
    }: {
      awaitedData?: unknown;
      maybeSingleData?: unknown;
      singleData?: unknown;
      onInsert?: (value: unknown) => void;
      onEq?: (field: string, value: unknown) => void;
    } = {}) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'or', 'order', 'limit', 'contains', 'gt', 'gte', 'in', 'is', 'neq', 'update', 'delete']) {
        query[method] = vi.fn(() => query);
      }
      query.eq = vi.fn((field: string, value: unknown) => {
        onEq?.(field, value);
        return query;
      });
      query.insert = vi.fn((value: unknown) => {
        onInsert?.(value);
        return query;
      });
      query.maybeSingle = vi.fn(async () => ({ data: maybeSingleData, error: null }));
      query.single = vi.fn(async () => ({ data: singleData, error: null }));
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: awaitedData, error: null }).then(resolve, reject);
      return query;
    };

    const from = vi.fn((table: string) => {
      if (table === 'feed_experiments') {
        return fluent({
          maybeSingleData: {
            id: 'experiment-1',
            experiment_key: 'for-you-v2',
            assignment_salt: 'salt-1',
            traffic_basis_points: 10_000,
            starts_at: null,
            ends_at: null,
            feed_experiment_variants: [{
              id: 'variant-treatment',
              variant_key: 'treatment',
              algorithm_version_id: 'algorithm-v2',
              allocation_basis_points: 10_000,
            }],
          },
        });
      }
      if (table === 'feed_experiment_assignments') {
        return fluent({
          maybeSingleData: { id: 44, variant_id: 'variant-treatment' },
        });
      }
      if (table === 'feed_algorithm_versions') {
        return fluent({
          maybeSingleData: {
            id: 'algorithm-v2',
            algorithm_key: 'for-you-rules',
            version: 2,
            weights: {},
            retrieval_config: {
              candidate_rpc: 'v2',
              session_item_limit: 60,
            },
            diversity_config: {},
          },
        });
      }
      if (table === 'feed_sessions') {
        sessionReads += 1;
        return sessionReads <= 2
          ? fluent({
            maybeSingleData: sessionReads === 1 ? {
              id: 'session-before-experiment',
              algorithm_version_id: 'algorithm-v2',
              experiment_assignment_id: null,
            } : null,
            onEq: (field, value) => sessionEqCalls.push([field, value]),
          })
          : fluent({ singleData: { id: 'session-v2' } });
      }
      if ([
        'feed_user_post_feedback', 'feed_user_creator_feedback', 'user_blocks', 'post_reports',
      ].includes(table)) {
        return fluent({ awaitedData: [] });
      }
      if (table === 'feed_session_items') {
        return fluent({ awaitedData: [{ id: 99, position: 0 }] });
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const rpc = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      if (name === 'persist_ranked_feed_session') {
        persistencePayload = payload;
        return { data: { session_id: 'session-v2', deliveries: [{ id: '99', position: 0 }] }, error: null };
      }
      return {
        data: [{
          post_id: 'exploration-post',
          freshness: 0.8,
          exploration_ucb: 0.9,
          candidate_source: 'exploration',
          seen_recently: false,
        }],
        error: null,
      };
    });

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: null,
      fallbackItems: vi.fn(async () => []),
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: vi.fn(async () => [item('exploration-post')]),
      limit: 12,
      offset: 0,
      serviceClient: { from, rpc } as unknown as SupabaseClient,
      viewerUserId: 'viewer-1',
    });

    expect(sessionEqCalls).toContainEqual(['viewer_user_id', 'viewer-1']);
    expect(sessionEqCalls).toContainEqual(['experiment_assignment_id', 44]);
    expect(sessionEqCalls).toContainEqual(['algorithm_version_id', 'algorithm-v2']);
    expect(persistencePayload).toMatchObject({
      p_session: { algorithm_version_id: 'algorithm-v2' },
      p_experiment: { assignment_id: 44, experiment_id: 'experiment-1', variant_id: 'variant-treatment' },
      p_items: [{ candidate_source: 'exploration' }],
    });
    expect(page.items[0]?.recommendation?.deliveryId).toBe('99');
    expect(page.feedSessionId).toBe('session-v2');
    expect(page.algorithmVersion).toBe('for-you-rules-v2');
  });

  it.each([false, true])('persists a ranked page in one RPC, with safe failure fallback: %s', async (fail) => {
    const postIds = Array.from({ length: 20 }, (_, index) => `post-${index}`);
    const insert = vi.fn(() => { throw new Error('No non-atomic writes'); });
    const query: Record<string, unknown> = { insert };
    for (const method of ['select', 'or', 'order', 'limit', 'contains', 'gt', 'gte', 'in', 'is', 'eq', 'neq']) {
      query[method] = vi.fn(() => query);
    }
    query.maybeSingle = async () => ({ data: null, error: null });
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    const algorithmQuery = {
      select: () => algorithmQuery,
      eq: () => algorithmQuery,
      maybeSingle: async () => ({ data: {
        id: 'algorithm-1', algorithm_key: 'for-you-rules', version: 1,
        weights: {}, retrieval_config: {}, diversity_config: {},
      }, error: null }),
    };
    const from = vi.fn((table: string) => table === 'feed_algorithm_versions' ? algorithmQuery : query);
    let persistencePayload: Record<string, unknown> = {};
    const rpc = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      if (name === 'persist_ranked_feed_session') {
        persistencePayload = payload;
        return {
          data: fail ? null : {
            session_id: 'session-slice',
            deliveries: postIds.map((_, position) => ({ id: String(500 + position), position })),
          },
          error: fail ? { code: '23503' } : null,
        };
      }
      return {
        data: postIds.map((post_id) => ({ post_id, freshness: 0.5, candidate_source: 'recent' })),
        error: null,
      };
    });
    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: 'ignored-for-signed-in', cursor: null,
      fallbackItems: async () => [],
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: async () => postIds.map(item),
      limit: 3, offset: 2, serviceClient: { from, rpc } as unknown as SupabaseClient,
      viewerUserId: 'viewer-1',
    });
    expect(insert).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('persist_ranked_feed_session', expect.objectContaining({
      p_offset: 2, p_limit: 3,
      p_session: expect.objectContaining({ viewer_user_id: 'viewer-1', anonymous_key_hash: null }),
      p_items: expect.arrayContaining([expect.objectContaining({ creator_user_id: 'creator-post-0' })]),
      p_experiment: { assignment_id: null, experiment_id: null, variant_id: null },
    }));
    expect(persistencePayload.p_items).toHaveLength(20);
    expect(page.items).toHaveLength(3);
    expect(page.pageInfo.hasMore).toBe(true);
    if (fail) {
      expect(page.feedSessionId).toBeNull();
      expect(page.pageInfo.nextCursor).toBeNull();
      expect(page.items.every((entry) => !entry.recommendation)).toBe(true);
    } else {
      expect(page.feedSessionId).toBe('session-slice');
      expect(page.items.map((entry) => entry.recommendation?.deliveryId)).toEqual(['502', '503', '504']);
      expect(decodeRankedFeedCursor(page.pageInfo.nextCursor!)).toEqual({ sessionId: 'session-slice', position: 5 });
    }
  });
});


describe('persisted feed hydration budget', () => {
  function persistedClient(hiddenPostIds: string[] = [], deletedPostIds: string[] = []) {
    const rows = Array.from({ length: 48 }, (_, position) => ({
      id: position + 1, post_id: `post-${position}`, position,
      candidate_source: 'interest', final_score: 1, score_components: {},
    }));
    const from = vi.fn((table: string) => {
      let position = 0;
      let limit = 24;
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query),
        order: vi.fn(() => query), in: vi.fn(() => query),
        gte: vi.fn((_field: string, value: number) => { position = value; return query; }),
        limit: vi.fn((value: number) => { limit = value; return query; }),
        maybeSingle: vi.fn(async () => ({ data: table === 'feed_sessions' ? {
          id: 'bounded-session', viewer_user_id: 'viewer', anonymous_key_hash: null,
          algorithm_version_id: 'algorithm', expires_at: '2099-01-01T00:00:00Z',
        } : {
          id: 'algorithm', algorithm_key: 'for-you-rules', version: 1,
          weights: {}, retrieval_config: {}, diversity_config: {},
        }, error: null })),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const data = table === 'feed_session_items' ? rows.slice(position, position + limit)
            : table === 'feed_user_post_feedback' ? hiddenPostIds.map(post_id => ({ post_id }))
            : [];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    });
    const hydratePostIds = vi.fn(async (ids: string[]) => ids
      .filter(id => !deletedPostIds.includes(id)).map(item));
    return { client: { from } as unknown as SupabaseClient, hydratePostIds };
  }

  it.each([1, 12, 24])('hydrates only a %i-item page plus one eligible lookahead', async (limit) => {
    const { client, hydratePostIds } = persistedClient();
    const onPhaseTiming = vi.fn();
    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null, cursor: encodeRankedFeedCursor({ sessionId: 'bounded-session', position: 0 }),
      fallbackItems: vi.fn(), filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds, onPhaseTiming, limit, offset: 0, serviceClient: client, viewerUserId: 'viewer',
    });
    expect(hydratePostIds).toHaveBeenCalledOnce();
    expect(hydratePostIds.mock.calls[0][0]).toHaveLength(limit + 1);
    expect(page.items.map(row => row.id)).toEqual(Array.from({ length: limit }, (_, i) => `post-${i}`));
    expect(onPhaseTiming.mock.calls.map(([phase]) => phase)).toEqual(
      expect.arrayContaining(['session_items', 'session_hydration', 'session_feedback']),
    );
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeRankedFeedCursor(page.pageInfo.nextCursor)?.position).toBe(limit);
  });

  it('fills through hidden and deleted posts without skipping cursor positions', async () => {
    const hidden = Array.from({ length: 12 }, (_, i) => `post-${i}`);
    const { client, hydratePostIds } = persistedClient(hidden, ['post-12', 'post-24']);
    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null, cursor: encodeRankedFeedCursor({ sessionId: 'bounded-session', position: 0 }),
      fallbackItems: vi.fn(), filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds, limit: 12, offset: 0, serviceClient: client, viewerUserId: 'viewer',
    });
    expect(page.items.map(row => row.id)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => `post-${i + 13}`), 'post-25',
    ]);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeRankedFeedCursor(page.pageInfo.nextCursor)?.position).toBe(26);
    const hydratedIds = hydratePostIds.mock.calls.flatMap(([ids]) => ids);
    expect(new Set(hydratedIds).size).toBe(hydratedIds.length);
  });
});

describe('v3 retrieval config', () => {
  const v3Defaults = {
    coldLimit: 50,
    coldMaxAgeHours: 168,
    coldImpressionThreshold: 60,
    maxAgeDays: 365,
    servedLookbackHours: 6,
    trendingPerAuthorCap: 5,
    creatorPriorMean: 0.15,
    sessionItemLimit: 60,
    visibilityThresholds: { recommendationMaxPostNegativeRisk: 1, recommendationMaxCreatorNegativeRate: 1 },
  };

  it('falls back to the RPC defaults outside each bound', () => {
    expect(normalizeRetrievalConfig({
      candidate_rpc: 'v3',
      cold_limit: 501,
      cold_max_age_hours: 8761,
      cold_impression_threshold: 12.5,
      max_age_days: 0,
      served_lookback_hours: -1,
      trending_per_author_cap: 51,
      creator_prior_mean: 1.5,
      session_item_limit: 61,
      recommendation_max_post_negative_risk: 2,
      recommendation_max_creator_negative_rate: -0.1,
    })).toMatchObject({ candidateRpc: 'v3', ...v3Defaults });
  });

  it('reads a JSON null as a missing key, never as a zero that switches a pool off', () => {
    expect(normalizeRetrievalConfig({
      candidate_rpc: 'v3',
      cold_limit: null,
      cold_max_age_hours: null,
      cold_impression_threshold: null,
      max_age_days: null,
      served_lookback_hours: null,
      trending_per_author_cap: null,
      creator_prior_mean: null,
      recommendation_max_post_negative_risk: null,
    })).toMatchObject(v3Defaults);
    // A deliberate 0 is still the kill switch.
    expect(normalizeRetrievalConfig({ cold_limit: 0, served_lookback_hours: 0, cold_max_age_hours: 0 }))
      .toMatchObject({ coldLimit: 0, servedLookbackHours: 0, coldMaxAgeHours: 0 });
  });

  it('leaves v1 and v2 rows on their own RPC with the v3 keys inert', () => {
    expect(normalizeRetrievalConfig({ candidate_rpc: 'v2' })).toMatchObject({ candidateRpc: 'v2', ...v3Defaults });
    expect(normalizeRetrievalConfig({ candidate_limit: 300 })).toMatchObject({ candidateRpc: 'v1', ...v3Defaults });
    expect(normalizeRetrievalConfig({ candidate_rpc: 'v5' }).candidateRpc).toBe('v1');
  });

  it('honours the recommendation thresholds only for the v3 RPC, the only one that reports follows', () => {
    const thresholds = { recommendation_max_post_negative_risk: 0.12, recommendation_max_creator_negative_rate: 0.08 };
    const off = v3Defaults.visibilityThresholds;

    expect(normalizeRetrievalConfig({ candidate_rpc: 'v3', ...thresholds }).visibilityThresholds)
      .toEqual({ recommendationMaxPostNegativeRisk: 0.12, recommendationMaxCreatorNegativeRate: 0.08 });
    // Without is_following every creator would be judged as a stranger.
    expect(normalizeRetrievalConfig({ candidate_rpc: 'v2', ...thresholds }).visibilityThresholds).toEqual(off);
    expect(normalizeRetrievalConfig(thresholds).visibilityThresholds).toEqual(off);
  });
});

describe('for-you-rules v3 wiring', () => {
  type PersistedRankedItem = {
    post_id: string;
    candidate_source: string;
    final_score: number;
    score_components: Record<string, unknown>;
  };
  type PersistedSession = { p_session: Record<string, unknown>; p_items: PersistedRankedItem[] };
  type TableRows = Record<string, Array<Record<string, unknown>>>;
  type AlgorithmRow = {
    id: string;
    algorithm_key: string;
    version: number;
    weights: Record<string, unknown>;
    retrieval_config: Record<string, unknown>;
    diversity_config: Record<string, unknown>;
  };

  const V3_ALGORITHM: AlgorithmRow = {
    id: 'algorithm-v3',
    algorithm_key: 'for-you-rules',
    version: 3,
    weights: FOR_YOU_RULES_V3_WEIGHTS,
    retrieval_config: FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
    diversity_config: FOR_YOU_RULES_V3_DIVERSITY_CONFIG,
  };

  /** A get_ranked_feed_candidates_v3 row: v2's columns, then v3's. */
  function v3Candidate(postId: string, overrides: Record<string, unknown> = {}) {
    return {
      post_id: postId,
      interest_match: 0.4,
      creator_affinity: 0,
      smoothed_usefulness: 0.2,
      freshness: 0.6,
      relevant_trend: 0.1,
      exploration_bonus: 0,
      quick_skip_risk: 0.1,
      negative_feedback_risk: 0.01,
      engagement_depth: 0.25,
      attention_seconds_norm: 0,
      creator_quality: 0.15,
      exploration_ucb: 0.5,
      seen_recently: false,
      last_seen_at: null,
      candidate_source: 'fresh',
      served_recently: false,
      is_following: false,
      // An exposed author and an old post: no cold-start draw unless a test asks.
      author_rendered_30d: 500,
      post_rendered_30d: 40,
      post_meaningful_30d: 4,
      post_age_hours: 500,
      reports_7d: 0,
      sources: ['fresh'],
      ...overrides,
    };
  }

  /**
   * A service client that answers each table from `rows`, applying the
   * eq / neq / in / gte filters and the limit the code sends, and records
   * every read and the persisted session.
   */
  function v3Client({
    algorithm = V3_ALGORITHM,
    candidates = [],
    failingTable = null,
    retrievalConfig = algorithm.retrieval_config,
    rows = {},
    session = null,
  }: {
    algorithm?: AlgorithmRow;
    candidates?: Array<Record<string, unknown>>;
    failingTable?: string | null;
    retrievalConfig?: Record<string, unknown>;
    rows?: TableRows;
    session?: Record<string, unknown> | null;
  } = {}) {
    const reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
    const persisted: PersistedSession[] = [];
    const from = vi.fn((table: string) => {
      const filters: Array<[string, string, unknown]> = [];
      let rowLimit = Number.POSITIVE_INFINITY;
      reads.push({ table, filters });
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'or', 'order', 'contains', 'gt', 'is', 'update']) {
        query[method] = vi.fn(() => query);
      }
      for (const operator of ['eq', 'neq', 'in', 'gte']) {
        query[operator] = vi.fn((field: string, value: unknown) => {
          filters.push([operator, field, value]);
          return query;
        });
      }
      query.limit = vi.fn((value: number) => {
        rowLimit = value;
        return query;
      });
      query.maybeSingle = vi.fn(async () => ({
        data: table === 'feed_algorithm_versions'
          ? { ...algorithm, retrieval_config: retrievalConfig }
          : table === 'feed_sessions' ? session : null,
        error: null,
      }));
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        const matching = (rows[table] ?? []).filter((row) => filters.every(([operator, field, value]) => (
          operator === 'eq' ? row[field] === value
            : operator === 'neq' ? row[field] !== value
              : operator === 'in' ? (value as unknown[]).includes(row[field])
                : Number(row[field]) >= Number(value)
        )));
        return Promise.resolve(table === failingTable
          ? { data: null, error: { message: `${table} is unavailable` } }
          : { data: matching.slice(0, rowLimit), error: null }).then(resolve, reject);
      };
      return query;
    });
    const rpc = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      // Every version's candidate RPC answers with the same rows.
      if (name.startsWith('get_ranked_feed_candidates')) return { data: candidates, error: null };
      if (name === 'persist_ranked_feed_session') {
        const persistedSession = payload as unknown as PersistedSession;
        persisted.push(persistedSession);
        return {
          data: {
            session_id: 'session-v3',
            deliveries: persistedSession.p_items.map((_, position) => ({ id: String(700 + position), position })),
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    return { client: { from, rpc } as unknown as SupabaseClient, persisted, reads, rpc };
  }

  function forYouPage(
    client: SupabaseClient,
    {
      anonymousKeyHash = null,
      cursor = null,
      fallback = [],
      offset = 0,
      viewerUserId = 'viewer-1',
    }: {
      anonymousKeyHash?: string | null;
      cursor?: string | null;
      fallback?: ShowcaseFeedItem[];
      offset?: number;
      viewerUserId?: string | null;
    } = {},
  ) {
    return getPersonalizedShowcaseFeedPage({
      anonymousKeyHash,
      cursor,
      fallbackItems: async () => fallback,
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: async (ids) => ids.map(item),
      limit: 12,
      offset,
      serviceClient: client,
      viewerUserId,
    });
  }

  async function spyOnRanking() {
    const ranking = await import('@/lib/showcase-feed-ranking');
    return vi.spyOn(ranking, 'rankAndDiversifyShowcaseItems');
  }

  async function spyOnVisibility() {
    const visibility = await import('@/lib/feed-visibility');
    return vi.spyOn(visibility, 'filterFeedVisibility');
  }

  function persistedIds(session: PersistedSession | undefined) {
    return (session?.p_items ?? []).map((entry) => entry.post_id).sort();
  }

  beforeEach(() => {
    loggerMocks.logBackendError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls get_ranked_feed_candidates_v3 with every retrieval parameter the version sets', async () => {
    const { client, rpc } = v3Client({
      candidates: [v3Candidate('post-a')],
      retrievalConfig: {
        ...FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
        following_limit: 80,
        interest_limit: 120,
        trending_limit: 90,
        recent_limit: 140,
        exploration_limit: 70,
        seen_lookback_days: 10,
        creator_prior_cap: 0.2,
        exploration_confidence: 1.2,
        cold_limit: 40,
        cold_max_age_hours: 72,
        cold_impression_threshold: 30,
        max_age_days: 90,
        served_lookback_hours: 12,
        trending_per_author_cap: 3,
        creator_prior_mean: 0.1,
      },
    });

    await forYouPage(client);

    // Exact: a parameter the code forgot, or one the RPC does not take, fails.
    expect(rpc).toHaveBeenCalledWith('get_ranked_feed_candidates_v3', {
      p_viewer_user_id: 'viewer-1',
      p_anonymous_key_hash: null,
      p_category: null,
      p_following_limit: 80,
      p_interest_limit: 120,
      p_trending_limit: 90,
      p_recent_limit: 140,
      p_exploration_limit: 70,
      p_seen_lookback_days: 10,
      p_creator_prior_cap: 0.2,
      p_exploration_confidence: 1.2,
      p_as_of: expect.any(String),
      p_cold_limit: 40,
      p_cold_max_age_hours: 72,
      p_cold_impression_threshold: 30,
      p_max_age_days: 90,
      p_served_lookback_hours: 12,
      p_trending_per_author_cap: 3,
      p_creator_prior_mean: 0.1,
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_ranked_feed_candidates_v3',
      'persist_ranked_feed_session',
    ]);
  });

  it('carries is_following, served_recently and every source into the ranked feature rows', async () => {
    const rankSpy = await spyOnRanking();
    const { client, persisted } = v3Client({
      candidates: [
        v3Candidate('followed', { is_following: true, candidate_source: 'following', sources: ['following', 'fresh'] }),
        v3Candidate('served', { served_recently: true }),
        v3Candidate('multi-source', { candidate_source: 'cold', sources: ['cold', 'affinity', 'trending'] }),
      ],
    });

    await forYouPage(client);

    const features = new Map(rankSpy.mock.calls[0][0].featureRows.map((row) => [row.postId, row]));
    expect(features.get('followed')).toMatchObject({
      isFollowing: true, servedRecently: false, sources: ['following', 'fresh'],
    });
    expect(features.get('served')).toMatchObject({ isFollowing: false, servedRecently: true, sources: ['fresh'] });
    expect(features.get('multi-source')).toMatchObject({
      candidateSource: 'cold', sources: ['cold', 'affinity', 'trending'],
    });

    const components = new Map(persisted[0].p_items.map((entry) => [entry.post_id, entry.score_components]));
    expect(components.get('followed')).toMatchObject({
      is_following: true, sources: ['following', 'fresh'], ranking: { oonMultiplier: 1 },
    });
    expect(components.get('served')).toMatchObject({
      served_recently: true, ranking: { servedPenalty: 0.5, oonMultiplier: 0.75 },
    });
    expect(components.get('multi-source')).toMatchObject({ sources: ['cold', 'affinity', 'trending'] });
  });

  it('persists how each score was reached under score_components.ranking', async () => {
    const rankSpy = await spyOnRanking();
    const { client, persisted } = v3Client({ candidates: ['a', 'b', 'c'].map((id) => v3Candidate(id)) });

    await forYouPage(client);

    const ranked: RankedShowcaseItem[] = rankSpy.mock.results[0].value;
    expect(persisted[0].p_items.map((entry) => entry.score_components.ranking))
      .toEqual(ranked.map((entry) => explainRankedFeedScore(entry)));
    expect(persisted[0].p_items[0].score_components.ranking).toEqual({
      base: expect.any(Number),
      offset: expect.any(Number),
      seenPenalty: null,
      servedPenalty: null,
      oonMultiplier: 0.75,
      authorDecay: { k: 0, multiplier: 1 },
      coldStart: null,
    });
    // Features stay at the top level, where a continuation page reads them back.
    expect(persisted[0].p_items[0].score_components).toMatchObject({ interest_match: 0.4, is_following: false });
  });

  it('ranks with the seed it persists as the session random_seed', async () => {
    const rankSpy = await spyOnRanking();
    const { client, persisted } = v3Client({
      candidates: Array.from({ length: 8 }, (_, index) => v3Candidate(`new-${index}`, {
        candidate_source: 'cold',
        sources: ['cold'],
        author_rendered_30d: 2,
        post_age_hours: 3 + index,
        post_rendered_30d: index,
        post_meaningful_30d: 0,
      })),
    });

    await forYouPage(client);

    const { seed } = rankSpy.mock.calls[0][0];
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2_147_483_647);
    expect(persisted[0].p_session.random_seed).toBe(seed);
    // The seed drove real Thompson draws, and exactly one post was picked.
    const coldStarts = persisted[0].p_items.map((entry) => (
      (entry.score_components.ranking as { coldStart: { picked: boolean } | null }).coldStart
    ));
    expect(coldStarts.every((coldStart) => coldStart !== null)).toBe(true);
    expect(coldStarts.filter((coldStart) => coldStart?.picked)).toHaveLength(1);
  });

  it("keeps a blocked creator's posts out of ranking and persistence, in either direction", async () => {
    const rankSpy = await spyOnRanking();
    const { client, persisted } = v3Client({
      candidates: [v3Candidate('kept'), v3Candidate('viewer-blocked'), v3Candidate('blocked-viewer')],
      rows: {
        user_blocks: [
          { blocker_user_id: 'viewer-1', blocked_user_id: 'creator-viewer-blocked' },
          { blocker_user_id: 'creator-blocked-viewer', blocked_user_id: 'viewer-1' },
        ],
      },
    });

    const page = await forYouPage(client);

    expect(rankSpy.mock.calls[0][0].items.map((entry) => entry.id)).toEqual(['kept']);
    expect(persistedIds(persisted[0])).toEqual(['kept']);
    expect(page.items.map((entry) => entry.id)).toEqual(['kept']);
  });

  it('drops a post the viewer reported, unless a moderator dismissed the report', async () => {
    const { client, persisted, reads } = v3Client({
      candidates: ['reported', 'dismissed', 'reported-by-someone-else', 'unreported'].map((id) => v3Candidate(id)),
      rows: {
        post_reports: [
          { post_id: 'reported', reporter_user_id: 'viewer-1', status: 'open' },
          { post_id: 'dismissed', reporter_user_id: 'viewer-1', status: 'dismissed' },
          { post_id: 'reported-by-someone-else', reporter_user_id: 'viewer-2', status: 'reviewed' },
        ],
      },
    });

    await forYouPage(client);

    expect(persistedIds(persisted[0])).toEqual(['dismissed', 'reported-by-someone-else', 'unreported']);
    expect(reads.find((read) => read.table === 'post_reports')?.filters).toEqual([
      ['eq', 'reporter_user_id', 'viewer-1'],
      ['neq', 'status', 'dismissed'],
      ['in', 'post_id', ['reported', 'dismissed', 'reported-by-someone-else', 'unreported']],
    ]);
  });

  it.each([
    'user_blocks',
    'post_reports',
    'feed_user_post_feedback',
    'feed_user_creator_feedback',
    'creator_feed_stats',
  ])('serves nothing when %s cannot be read', async (failingTable) => {
    const { client, persisted } = v3Client({
      candidates: [v3Candidate('a'), v3Candidate('b')],
      failingTable,
    });

    const page = await forYouPage(client);

    expect(page.items).toEqual([]);
    expect(page.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
    expect(persisted).toEqual([]);
    expect(loggerMocks.logBackendError).toHaveBeenCalledWith(
      expect.stringMatching(/^error_loading_feed_/),
      { error: expect.anything() },
    );
  });

  it('loads no relations for a signed-out viewer and still applies the post rules', async () => {
    const { client, persisted, reads } = v3Client({
      candidates: [v3Candidate('calm'), v3Candidate('risky', { negative_feedback_risk: 0.5 })],
    });

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: 'a'.repeat(64),
      cursor: null,
      fallbackItems: async () => [],
      filters: { category: 'all', toolSlug: null, unlockFilter: 'all', resourceFilter: 'all' },
      hydratePostIds: async (ids) => ids.map(item),
      limit: 12,
      offset: 0,
      serviceClient: client,
      viewerUserId: null,
    });

    expect(page.items.map((entry) => entry.id)).toEqual(['calm']);
    expect(persistedIds(persisted[0])).toEqual(['calm']);
    const relationTables = ['user_blocks', 'post_reports', 'feed_user_post_feedback', 'feed_user_creator_feedback'];
    expect(reads.filter((read) => relationTables.includes(read.table))).toEqual([]);
  });

  it('records recent top-up posts as coming from the fresh pool', async () => {
    const { client, persisted } = v3Client({
      candidates: [v3Candidate('ranked', { candidate_source: 'affinity', sources: ['affinity'] })],
    });

    await forYouPage(client, { fallback: [item('top-up')] });

    const byPost = new Map(persisted[0].p_items.map((entry) => [entry.post_id, entry]));
    // The synthetic label is unchanged (an underexposed post is labelled
    // exploration); `sources` says which pool it actually came from.
    expect(byPost.get('top-up')).toMatchObject({
      candidate_source: 'exploration',
      score_components: { sources: ['fresh'] },
    });
    expect(byPost.get('ranked')?.score_components.sources).toEqual(['affinity']);
  });

  it('applies the negative-feedback rules only to creators the viewer does not follow', async () => {
    const candidates = [
      v3Candidate('calm'),
      v3Candidate('risky-stranger', { negative_feedback_risk: 0.3 }),
      v3Candidate('risky-followed', { negative_feedback_risk: 0.3, is_following: true }),
      v3Candidate('noisy-stranger'),
      v3Candidate('noisy-followed', { is_following: true }),
    ];
    const rows = {
      creator_feed_stats: [
        { creator_user_id: 'creator-noisy-stranger', window_key: '30d', negative_feedback_rate: 0.2, rendered_count: 100 },
        { creator_user_id: 'creator-noisy-followed', window_key: '30d', negative_feedback_rate: 0.2, rendered_count: 100 },
        // Another window never counts.
        { creator_user_id: 'creator-calm', window_key: '7d', negative_feedback_rate: 0.9, rendered_count: 100 },
      ],
    };
    const v3 = v3Client({ candidates, rows });

    await forYouPage(v3.client);

    expect(persistedIds(v3.persisted[0])).toEqual(['calm', 'noisy-followed', 'risky-followed']);

    // At 1 both rules are off, and the creator rates are not even read.
    const switchedOff = v3Client({
      candidates,
      rows,
      retrievalConfig: {
        ...FOR_YOU_RULES_V3_RETRIEVAL_CONFIG,
        recommendation_max_post_negative_risk: 1,
        recommendation_max_creator_negative_rate: 1,
      },
    });

    await forYouPage(switchedOff.client);

    expect(persistedIds(switchedOff.persisted[0])).toEqual(candidates.map((row) => row.post_id).sort());
    expect(switchedOff.reads.map((read) => read.table)).not.toContain('creator_feed_stats');
  });

  it('re-applies visibility on a continuation page, at the level the session was ranked at', async () => {
    const sessionRow = (postId: string, position: number, components: Record<string, unknown> = {}) => ({
      id: 900 + position,
      session_id: 'session-v3',
      post_id: postId,
      position,
      candidate_source: 'fresh',
      final_score: 0.5,
      score_components: { negative_feedback_risk: 0.01, is_following: false, ...components },
    });
    const { client, rpc } = v3Client({
      session: {
        id: 'session-v3',
        viewer_user_id: 'viewer-1',
        anonymous_key_hash: null,
        algorithm_version_id: 'algorithm-v3',
        created_at: new Date().toISOString(),
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      rows: {
        feed_session_items: [
          sessionRow('still-fine', 12),
          sessionRow('blocked-since', 13),
          sessionRow('reported-since', 14),
          sessionRow('risky-followed', 15, { negative_feedback_risk: 0.5, is_following: true }),
          sessionRow('risky-stranger', 16, { negative_feedback_risk: 0.5 }),
        ],
        user_blocks: [{ blocker_user_id: 'viewer-1', blocked_user_id: 'creator-blocked-since' }],
        post_reports: [{ post_id: 'reported-since', reporter_user_id: 'viewer-1', status: 'open' }],
      },
    });

    const page = await forYouPage(client, {
      cursor: encodeRankedFeedCursor({ sessionId: 'session-v3', position: 12 }),
    });

    expect(page.feedSessionId).toBe('session-v3');
    expect(page.items.map((entry) => entry.id)).toEqual(['still-fine', 'risky-followed']);
    expect(page.items.map((entry) => entry.recommendation?.deliveryId)).toEqual(['912', '915']);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('judges a creator\'s negative rate only once the creator has the cold-start threshold\'s exposure', async () => {
    const visibilitySpy = await spyOnVisibility();
    const { client, persisted } = v3Client({
      candidates: [v3Candidate('new-author'), v3Candidate('known-author')],
      rows: {
        creator_feed_stats: [
          // One open report is two negatives: (2 + 0.2) / (7 + 20) is past 0.08 already.
          { creator_user_id: 'creator-new-author', window_key: '30d', negative_feedback_rate: 0.11, rendered_count: 7 },
          { creator_user_id: 'creator-known-author', window_key: '30d', negative_feedback_rate: 0.11, rendered_count: 60 },
        ],
      },
    });

    await forYouPage(client);

    expect(persistedIds(persisted[0])).toEqual(['new-author']);
    expect(visibilitySpy.mock.results[0].value.dropped).toEqual([
      { postId: 'known-author', reason: 'creator_negative_feedback' },
    ]);
  });

  it.each([
    ['v1', {}],
    ['v2', { candidate_rpc: 'v2' }],
  ])('keeps the v3 columns and the recommendation rules out of a %s session', async (_label, retrievalConfig) => {
    const { client, persisted, reads } = v3Client({
      algorithm: { ...V3_ALGORITHM, id: 'algorithm-old', version: 1, weights: {}, diversity_config: {} },
      candidates: [
        v3Candidate('followed', { is_following: true }),
        // Past v3's post threshold: an older version never applies it.
        v3Candidate('risky', { negative_feedback_risk: 0.5 }),
      ],
      retrievalConfig: {
        ...retrievalConfig,
        recommendation_max_post_negative_risk: 0.12,
        recommendation_max_creator_negative_rate: 0.08,
      },
      rows: {
        creator_feed_stats: [
          { creator_user_id: 'creator-followed', window_key: '30d', negative_feedback_rate: 0.5, rendered_count: 500 },
        ],
      },
    });

    await forYouPage(client);

    expect(persistedIds(persisted[0])).toEqual(['followed', 'risky']);
    expect(reads.map((read) => read.table)).not.toContain('creator_feed_stats');
    for (const entry of persisted[0].p_items) {
      expect(entry.score_components.ranking).toMatchObject({ base: expect.any(Number), coldStart: null });
      expect(entry.score_components).toHaveProperty('interest_match');
      for (const key of [
        'is_following', 'served_recently', 'author_rendered_30d', 'post_rendered_30d',
        'post_meaningful_30d', 'post_age_hours', 'reports_7d', 'sources',
      ]) {
        expect(entry.score_components).not.toHaveProperty(key);
      }
    }
  });

  it('seeds every ranking no cursor can resume from a 10-minute bucket, and a resumable session at random', async () => {
    const rankSpy = await spyOnRanking();
    const now = vi.spyOn(Date, 'now');
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const bucketStart = 2_000_000 * 600_000;
    const candidates = ['a', 'b', 'c'].map((id) => v3Candidate(id));
    const seedAt = async (at: number, options: Parameters<typeof forYouPage>[1]) => {
      now.mockReturnValue(at);
      await forYouPage(v3Client({ candidates }).client, options);
      return rankSpy.mock.calls.at(-1)?.[0].seed;
    };

    // The cached identityless page 1, then two signed-out page 2 rankings
    // minutes apart (one already carrying a key): one bucket, one seed.
    expect(await seedAt(bucketStart + 60_000, { viewerUserId: null })).toBe(2_000_000);
    expect(await seedAt(bucketStart + 4 * 60_000, { viewerUserId: null, offset: 12 })).toBe(2_000_000);
    expect(await seedAt(bucketStart + 9 * 60_000, { viewerUserId: null, anonymousKeyHash: 'a'.repeat(64), offset: 12 }))
      .toBe(2_000_000);
    // A signed-in viewer paging by offset re-ranks too.
    expect(await seedAt(bucketStart + 2 * 60_000, { offset: 24 })).toBe(2_000_000);
    // The next bucket moves on.
    expect(await seedAt(bucketStart + 10 * 60_000, { viewerUserId: null, offset: 12 })).toBe(2_000_001);
    // A first page with an identity opens a session its cursor resumes: random.
    expect(await seedAt(bucketStart + 60_000, {})).toBe(Math.floor(0.25 * 2_147_483_647));
    expect(await seedAt(bucketStart + 60_000, { viewerUserId: null, anonymousKeyHash: 'a'.repeat(64) }))
      .toBe(Math.floor(0.25 * 2_147_483_647));
  });

  it.each([
    [60, 10],
    [55, 15],
  ])('keeps up to 10 of the 60 hydrated places for the cold pool (%i established, %i cold)', async (establishedCount, coldCount) => {
    const rankSpy = await spyOnRanking();
    // Every cold row scores below every established one.
    const established = Array.from({ length: establishedCount }, (_, index) => v3Candidate(`est-${index}`, {
      interest_match: 0.9 - index * 0.005,
    }));
    const cold = Array.from({ length: coldCount }, (_, index) => v3Candidate(`cold-${index}`, {
      candidate_source: 'cold',
      sources: ['cold', 'fresh'],
      interest_match: 0,
      smoothed_usefulness: 0,
      freshness: 0,
      engagement_depth: 0,
      exploration_ucb: 0.5 - index * 0.01,
      author_rendered_30d: 0,
      post_age_hours: 2,
      post_rendered_30d: 0,
      post_meaningful_30d: 0,
    }));
    const rankedIds = async (retrievalConfig: Record<string, unknown>) => {
      rankSpy.mockClear();
      await forYouPage(v3Client({ candidates: [...cold, ...established], retrievalConfig }).client);
      return rankSpy.mock.calls[0][0].items.map((entry) => entry.id).sort();
    };
    const ids = (rows: Array<{ post_id: string }>) => rows.map((row) => row.post_id);

    // The ten best cold rows displace the lowest established ones.
    expect(await rankedIds(FOR_YOU_RULES_V3_RETRIEVAL_CONFIG))
      .toEqual([...ids(cold.slice(0, 10)), ...ids(established.slice(0, 50))].sort());
    // v2 retrieves no cold pool and keeps the plain top 60.
    expect(await rankedIds({ ...FOR_YOU_RULES_V3_RETRIEVAL_CONFIG, candidate_rpc: 'v2' }))
      .toEqual([...ids(established), ...ids(cold.slice(0, 60 - establishedCount))].sort());
  });

  it('keeps no place for a cold post the viewer saw, or was served and passed over', async () => {
    const rankSpy = await spyOnRanking();
    const established = Array.from({ length: 60 }, (_, index) => v3Candidate(`est-${index}`, {
      interest_match: 0.9 - index * 0.005,
    }));
    const coldRow = (postId: string, overrides: Record<string, unknown>) => v3Candidate(postId, {
      candidate_source: 'cold', sources: ['cold'], interest_match: 0.1, author_rendered_30d: 0, post_age_hours: 2,
      ...overrides,
    });

    await forYouPage(v3Client({
      candidates: [
        ...established,
        coldRow('cold-seen', { seen_recently: true, last_seen_at: '2026-10-11T00:00:00.000Z' }),
        coldRow('cold-served', { served_recently: true }),
        coldRow('cold-unserved', { interest_match: 0.05 }),
      ],
    }).client);

    const ids: string[] = rankSpy.mock.calls[0][0].items.map((entry) => entry.id);
    expect(ids).toHaveLength(60);
    expect(ids.filter((id) => id.startsWith('cold-'))).toEqual(['cold-unserved']);
    expect(ids).not.toContain('est-59');
  });

  // -------------------------------------------------------------------------
  // v4: taste-vector retrieval, semantic features and account labels.
  // -------------------------------------------------------------------------

  const V4_ALGORITHM: AlgorithmRow = {
    id: 'algorithm-v4',
    algorithm_key: 'for-you-rules',
    version: 4,
    weights: FOR_YOU_RULES_V4_WEIGHTS,
    retrieval_config: FOR_YOU_RULES_V4_RETRIEVAL_CONFIG,
    diversity_config: FOR_YOU_RULES_V4_DIVERSITY_CONFIG,
  };

  /** A get_ranked_feed_candidates_v4 row: v3's columns, then v4's. */
  function v4Candidate(postId: string, overrides: Record<string, unknown> = {}) {
    return v3Candidate(postId, {
      semantic_similarity: 0.3,
      semantic_cluster: 'c4',
      taste_available: true,
      ...overrides,
    });
  }

  it('calls get_ranked_feed_candidates_v4 with every v3 parameter and every v4 one', async () => {
    const { client, rpc } = v3Client({
      algorithm: V4_ALGORITHM,
      candidates: [v4Candidate('post-a')],
      retrievalConfig: {
        ...FOR_YOU_RULES_V4_RETRIEVAL_CONFIG,
        cold_limit: 40,
        semantic_limit: 120,
        semantic_min_similarity: -0.25,
        taste_lookback_days: 30,
        taste_limit: 20,
        exclude_near_duplicates: false,
        exclude_labelled_accounts: false,
      },
    });

    await forYouPage(client);

    // Exact: a parameter the code forgot, or one the RPC does not take, fails.
    expect(rpc).toHaveBeenCalledWith('get_ranked_feed_candidates_v4', {
      p_viewer_user_id: 'viewer-1',
      p_anonymous_key_hash: null,
      p_category: null,
      p_following_limit: 100,
      p_interest_limit: 150,
      p_trending_limit: 100,
      p_recent_limit: 150,
      p_exploration_limit: 100,
      p_seen_lookback_days: 14,
      p_creator_prior_cap: 0.15,
      p_exploration_confidence: 1.5,
      p_as_of: expect.any(String),
      p_cold_limit: 40,
      p_cold_max_age_hours: 168,
      p_cold_impression_threshold: 60,
      p_max_age_days: 365,
      p_served_lookback_hours: 6,
      p_trending_per_author_cap: 5,
      p_creator_prior_mean: 0.15,
      p_semantic_limit: 120,
      p_semantic_min_similarity: -0.25,
      p_taste_lookback_days: 30,
      p_taste_limit: 20,
      p_exclude_near_duplicates: false,
      p_exclude_labelled_accounts: false,
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_ranked_feed_candidates_v4',
      'persist_ranked_feed_session',
    ]);
  });

  it('passes the seeded v4 parameters for an anonymous viewer', async () => {
    const { client, rpc } = v3Client({ algorithm: V4_ALGORITHM, candidates: [v4Candidate('post-a')] });

    await forYouPage(client, { anonymousKeyHash: 'a'.repeat(64), viewerUserId: null });

    expect(rpc).toHaveBeenCalledWith('get_ranked_feed_candidates_v4', expect.objectContaining({
      p_viewer_user_id: null,
      p_anonymous_key_hash: 'a'.repeat(64),
      p_semantic_limit: 150,
      p_semantic_min_similarity: 0,
      p_taste_lookback_days: 90,
      p_taste_limit: 50,
      p_exclude_near_duplicates: true,
      p_exclude_labelled_accounts: true,
    }));
  });

  it('carries the semantic columns into the feature rows, the score and score_components', async () => {
    const rankSpy = await spyOnRanking();
    const { client, persisted } = v3Client({
      algorithm: V4_ALGORITHM,
      candidates: [
        v4Candidate('close', { candidate_source: 'semantic', sources: ['semantic', 'fresh'], semantic_similarity: 0.82 }),
        v4Candidate('far', { semantic_similarity: 0, semantic_cluster: null }),
      ],
    });

    const page = await forYouPage(client);

    const features = new Map(rankSpy.mock.calls[0][0].featureRows.map((row) => [row.postId, row]));
    expect(features.get('close')).toMatchObject({
      candidateSource: 'semantic', semanticSimilarity: 0.82, semanticCluster: 'c4', tasteAvailable: true,
    });
    expect(features.get('far')).toMatchObject({ semanticSimilarity: 0, semanticCluster: null });
    // 0.14 × 0.82 is the whole difference between the two otherwise equal rows.
    const ranked: RankedShowcaseItem[] = rankSpy.mock.results[0].value;
    const base = new Map(ranked.map((entry) => [entry.item.id, entry.components.base]));
    expect((base.get('close') ?? 0) - (base.get('far') ?? 0)).toBeCloseTo(0.14 * 0.82, 12);

    const components = new Map(persisted[0].p_items.map((entry) => [entry.post_id, entry.score_components]));
    expect(components.get('close')).toMatchObject({
      semantic_similarity: 0.82, semantic_cluster: 'c4', taste_available: true, sources: ['semantic', 'fresh'],
    });
    expect(components.get('far')).toMatchObject({ semantic_similarity: 0, semantic_cluster: null });
    expect(page.items.find((entry) => entry.id === 'close')?.recommendation).toMatchObject({
      candidateSource: 'semantic',
      reason: 'Close to what you saved',
      algorithmVersion: 'for-you-rules-v4',
    });
  });

  it('keeps the v4 columns out of a v3 session, even when the RPC row carries them', async () => {
    const { client, persisted } = v3Client({ candidates: [v4Candidate('post-a', { semantic_similarity: 0.9 })] });

    await forYouPage(client);

    expect(persisted[0].p_items[0].score_components).toMatchObject({ is_following: false });
    expect(persisted[0].p_items[0].score_components).not.toHaveProperty('semantic_similarity');
    expect(persisted[0].p_items[0].score_components).not.toHaveProperty('taste_available');
  });

  it('drops a labelled stranger from a v4 page and keeps a labelled creator the viewer follows', async () => {
    const visibilitySpy = await spyOnVisibility();
    const { client, persisted, reads } = v3Client({
      algorithm: V4_ALGORITHM,
      candidates: [
        v4Candidate('plain'),
        v4Candidate('labelled-stranger'),
        v4Candidate('labelled-followed', { is_following: true, candidate_source: 'following' }),
      ],
      rows: {
        account_labels: [
          { user_id: 'creator-labelled-stranger', label: 'nsfw_account' },
          { user_id: 'creator-labelled-followed', label: 'negative_feedback_account' },
        ],
      },
    });

    await forYouPage(client);

    expect(persistedIds(persisted[0])).toEqual(['labelled-followed', 'plain']);
    expect(visibilitySpy.mock.results[0].value.dropped).toEqual([
      { postId: 'labelled-stranger', reason: 'labelled_account' },
    ]);
    const labelRead = reads.find((read) => read.table === 'account_labels');
    expect(labelRead?.filters).toEqual([
      ['in', 'user_id', ['creator-plain', 'creator-labelled-stranger', 'creator-labelled-followed']],
    ]);
  });

  it('reads no labels for a v3 ranking', async () => {
    const { client, persisted, reads } = v3Client({
      candidates: [v3Candidate('labelled-stranger')],
      rows: { account_labels: [{ user_id: 'creator-labelled-stranger', label: 'spam_account' }] },
    });

    await forYouPage(client);

    expect(reads.map((read) => read.table)).not.toContain('account_labels');
    expect(persistedIds(persisted[0])).toEqual(['labelled-stranger']);
  });

  it('empties a v4 page when the labels cannot be read, as for the other relation reads', async () => {
    const { client, persisted } = v3Client({
      algorithm: V4_ALGORITHM,
      candidates: [v4Candidate('post-a'), v4Candidate('post-b')],
      failingTable: 'account_labels',
    });

    const page = await forYouPage(client);

    expect(page.items).toEqual([]);
    expect(persisted).toEqual([]);
    expect(loggerMocks.logBackendError).toHaveBeenCalledWith(
      'error_loading_feed_author_labels',
      expect.anything(),
    );
  });

  it('re-applies the labels on a v4 continuation page, and fails it closed when they cannot be read', async () => {
    const sessionRow = (postId: string, position: number, components: Record<string, unknown> = {}) => ({
      id: 900 + position,
      session_id: 'session-v4',
      post_id: postId,
      position,
      candidate_source: 'fresh',
      final_score: 0.5,
      score_components: { negative_feedback_risk: 0.01, is_following: false, ...components },
    });
    const session = {
      id: 'session-v4',
      viewer_user_id: 'viewer-1',
      anonymous_key_hash: null,
      algorithm_version_id: 'algorithm-v4',
      created_at: new Date().toISOString(),
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    const rows = {
      feed_session_items: [
        sessionRow('still-fine', 12),
        sessionRow('labelled-since', 13),
        sessionRow('labelled-followed', 14, { is_following: true }),
      ],
      account_labels: [
        { user_id: 'creator-labelled-since', label: 'spam_account' },
        { user_id: 'creator-labelled-followed', label: 'spam_account' },
      ],
    };
    const cursor = encodeRankedFeedCursor({ sessionId: 'session-v4', position: 12 });

    const page = await forYouPage(v3Client({ algorithm: V4_ALGORITHM, session, rows }).client, { cursor });

    expect(page.items.map((entry) => entry.id)).toEqual(['still-fine', 'labelled-followed']);

    const failing = await forYouPage(
      v3Client({ algorithm: V4_ALGORITHM, session, rows, failingTable: 'account_labels' }).client,
      { cursor },
    );
    expect(failing.items).toEqual([]);
    expect(failing.pageInfo.hasMore).toBe(false);
  });
});

describe('v4 retrieval config', () => {
  const v4Defaults = {
    semanticLimit: 150,
    semanticMinSimilarity: 0,
    tasteLookbackDays: 90,
    tasteLimit: 50,
    excludeNearDuplicates: true,
    excludeLabelledAccounts: true,
  };

  it('reads every seeded v4 key, and the v3 thresholds with them', () => {
    expect(normalizeRetrievalConfig(FOR_YOU_RULES_V4_RETRIEVAL_CONFIG)).toMatchObject({
      candidateRpc: 'v4',
      ...v4Defaults,
      coldLimit: 50,
      visibilityThresholds: { recommendationMaxPostNegativeRisk: 0.12, recommendationMaxCreatorNegativeRate: 0.08 },
    });
  });

  it('reads the v4 keys within their bounds, inclusive', () => {
    expect(normalizeRetrievalConfig({
      candidate_rpc: 'v4',
      semantic_limit: 0,
      semantic_min_similarity: -1,
      taste_lookback_days: 365,
      taste_limit: 200,
      exclude_near_duplicates: false,
      exclude_labelled_accounts: false,
    })).toMatchObject({
      semanticLimit: 0,
      semanticMinSimilarity: -1,
      tasteLookbackDays: 365,
      tasteLimit: 200,
      excludeNearDuplicates: false,
      excludeLabelledAccounts: false,
    });
    expect(normalizeRetrievalConfig({ candidate_rpc: 'v4', semantic_limit: 500, semantic_min_similarity: 1, taste_lookback_days: 1, taste_limit: 1 }))
      .toMatchObject({ semanticLimit: 500, semanticMinSimilarity: 1, tasteLookbackDays: 1, tasteLimit: 1 });
  });

  it('falls back to the RPC defaults outside each bound, for null, and for a non-boolean switch', () => {
    expect(normalizeRetrievalConfig({
      candidate_rpc: 'v4',
      semantic_limit: 501,
      semantic_min_similarity: 1.5,
      taste_lookback_days: 0,
      taste_limit: 201,
      exclude_near_duplicates: 'false',
      exclude_labelled_accounts: 0,
    })).toMatchObject(v4Defaults);
    expect(normalizeRetrievalConfig({
      candidate_rpc: 'v4',
      semantic_limit: null,
      semantic_min_similarity: null,
      taste_lookback_days: null,
      taste_limit: 12.5,
      exclude_near_duplicates: null,
      exclude_labelled_accounts: null,
    })).toMatchObject(v4Defaults);
    expect(normalizeRetrievalConfig({ candidate_rpc: 'v4', semantic_min_similarity: true }).semanticMinSimilarity).toBe(0);
  });
});

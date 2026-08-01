import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getPersonalizedShowcaseFeedPage } from '@/lib/showcase-feed-personalization';
import { decodeRankedFeedCursor, encodeRankedFeedCursor } from '@/lib/showcase-feed-ranking';
import type { ShowcaseFeedItem } from '@/lib/showcase';

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

  it('reuses a recent matching initial session instead of reranking or inserting another one', async () => {
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
    const fluent = (options: { maybeSingleData?: unknown; awaitedData?: unknown }) => {
      const query: Record<string, unknown> = {};
      for (const method of ['select', 'in', 'gt', 'gte', 'lt', 'order', 'limit', 'update', 'delete']) {
        query[method] = vi.fn(() => query);
      }
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
    const from = vi.fn((table: string) => {
      if (table === 'feed_algorithm_versions') {
        algorithmReads += 1;
        return fluent({ maybeSingleData: activeAlgorithm });
      }
      if (table === 'feed_sessions') {
        sessionReads += 1;
        if (sessionReads === 1) return fluent({ maybeSingleData: { id: 'session-reused' } });
        if (sessionReads === 2) {
          return fluent({
            maybeSingleData: {
              id: 'session-reused',
              viewer_user_id: null,
              anonymous_key_hash: anonymousKeyHash,
              algorithm_version_id: 'algorithm-7',
              created_at: new Date().toISOString(),
              expires_at: '2099-01-01T00:00:00.000Z',
            },
          });
        }
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

    const page = await getPersonalizedShowcaseFeedPage({
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

    expect(algorithmReads).toBe(2);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(insertCalls.every((insert) => insert.mock.calls.length === 0)).toBe(true);
    expect(containsCalls).toContainEqual(['filters', {
      category: 'all', toolSlug: 'video-tool', unlockFilter: 'all', resourceFilter: 'all',
    }]);
    expect(isCalls).toContainEqual(['experiment_assignment_id', null]);
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
      for (const method of ['select', 'eq', 'gte', 'order', 'limit', 'update', 'is']) {
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
      if (table === 'feed_delivery_facts') {
        return fluent({ awaitedData: [] });
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const hydratePostIds = vi.fn(async (ids: string[]) => (
      ids.filter((id) => id !== 'deleted').map((id) => item(id))
    ));

    const page = await getPersonalizedShowcaseFeedPage({
      anonymousKeyHash: null,
      cursor: encodeRankedFeedCursor({ sessionId: 'gap-session', position: 0 }),
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
    const factInserts: Array<Record<string, unknown>> = [];
    const sessionEqCalls: Array<[string, unknown]> = [];
    let sessionReads = 0;
    let factReads = 0;

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
      for (const method of ['select', 'or', 'order', 'limit', 'contains', 'gt', 'gte', 'in', 'is', 'update', 'delete']) {
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
        return sessionReads === 1
          ? fluent({
            maybeSingleData: null,
            onEq: (field, value) => sessionEqCalls.push([field, value]),
          })
          : fluent({ singleData: { id: 'session-v2' } });
      }
      if (table === 'feed_user_post_feedback' || table === 'feed_user_creator_feedback') {
        return fluent({ awaitedData: [] });
      }
      if (table === 'feed_session_items') {
        return fluent({ awaitedData: [{ id: 99, position: 0 }] });
      }
      if (table === 'feed_delivery_facts') {
        factReads += 1;
        return factReads === 1
          ? fluent({
            onInsert: (value) => {
              factInserts.push(...(value as Array<Record<string, unknown>>));
            },
          })
          : fluent();
      }
      throw new Error(`Unexpected table ${table}`);
    });
    const rpc = vi.fn(async () => ({
      data: [{
        post_id: 'exploration-post',
        freshness: 0.8,
        exploration_ucb: 0.9,
        candidate_source: 'exploration',
        seen_recently: false,
      }],
      error: null,
    }));

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

    expect(sessionEqCalls).toContainEqual(['experiment_assignment_id', 44]);
    expect(factInserts).toHaveLength(1);
    expect(factInserts[0]).toMatchObject({
      delivery_id: 99,
      algorithm_version_id: 'algorithm-v2',
      experiment_assignment_id: 44,
      experiment_id: 'experiment-1',
      experiment_variant_id: 'variant-treatment',
      candidate_source: 'exploration',
      is_exploration: true,
      exploration_propensity: 1,
    });
    expect(page.feedSessionId).toBe('session-v2');
    expect(page.algorithmVersion).toBe('for-you-rules-v2');
  });
});

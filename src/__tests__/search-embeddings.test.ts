import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  SEARCH_EMBEDDING_BATCH_SIZE,
  SEARCH_EMBEDDING_MODEL,
  SEARCH_EMBEDDING_PENDING_LIMIT,
  SEARCH_EMBEDDING_REQUEST_BUDGET_MS,
  SEARCH_QUERY_EMBEDDING_DAILY_CAP,
  SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT,
  SEARCH_QUERY_EMBEDDING_TIMEOUT_MS,
  SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT,
  SEARCH_RELATED_MAX_POSTS,
  SEARCH_RELATED_THIN_POST_COUNT,
  findRelatedPostRows,
  hasSearchEmbeddingWork,
  isSearchSemanticDisabled,
  normalizeSearchQueryForEmbedding,
  requestQueryEmbedding,
  requestSearchEmbeddings,
  runSearchEmbeddingJob,
  searchQueryEmbeddingHash,
} from '@/lib/search-embeddings';

// The server half of search by meaning: the search-embeddings job and the
// read /api/search makes when its own answer is thin. The database's part is
// supabase/tests/database/search_related_posts.test.sql; the edge function's
// is embed-post-search-modes.test.ts.

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
};
const FUNCTION_URL = 'https://project.supabase.co/functions/v1/embed-post';
const CONFIG = { url: FUNCTION_URL, serviceRoleKey: ENV.SUPABASE_SERVICE_ROLE_KEY };

function postId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

const VECTOR = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
const VECTOR_TEXT = `[${VECTOR.join(',')}]`;

type RpcAnswer = { data?: unknown; error?: unknown };
type RpcHandlers = Record<string, (args: Record<string, unknown>) => RpcAnswer | Promise<RpcAnswer>>;

function clientWith(handlers: RpcHandlers) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) return { data: null, error: { code: 'PGRST202', message: `no function ${name}` } };
    const answer = await handler(args);
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  return { client: { rpc } as unknown as SupabaseClient, calls };
}

function jsonFetch(answer: (body: Record<string, unknown>) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const result = await answer(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  });
}

/** A scheduler that holds its tasks until the test runs them, as `after` holds them until the answer is out. */
function heldScheduler() {
  const tasks: Array<() => Promise<unknown>> = [];
  return {
    runAfterResponse: (task: () => Promise<unknown>) => { tasks.push(task); },
    tasks,
    async runAll() { for (const task of tasks.splice(0)) await task(); },
  };
}

describe('search semantic constants', () => {
  it('keeps the bounds the runbook states', () => {
    expect(SEARCH_EMBEDDING_MODEL).toBe('gte-small');
    expect(SEARCH_EMBEDDING_PENDING_LIMIT).toBe(96);
    expect(SEARCH_EMBEDDING_BATCH_SIZE).toBe(8);
    expect(SEARCH_RELATED_THIN_POST_COUNT).toBe(6);
    expect(SEARCH_RELATED_MAX_POSTS).toBe(8);
    expect(SEARCH_QUERY_EMBEDDING_TIMEOUT_MS).toBe(1_200);
    // The database never allows more than 5,000 a day whatever is sent.
    expect(SEARCH_QUERY_EMBEDDING_DAILY_CAP).toBe(2_000);
    expect(SEARCH_QUERY_EMBEDDING_DAILY_CAP).toBeLessThanOrEqual(5_000);
    // One viewer's share of the day: a UTC day's window, its own scope.
    expect(SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT).toEqual({
      scope: 'public-search:related-embedding', limit: 40, windowSeconds: 86_400,
    });
  });

  it('reads the kill switch on every use', () => {
    expect(isSearchSemanticDisabled({})).toBe(false);
    expect(isSearchSemanticDisabled({ SEARCH_SEMANTIC_DISABLED: '0' })).toBe(false);
    expect(isSearchSemanticDisabled({ SEARCH_SEMANTIC_DISABLED: '1' })).toBe(true);
    expect(isSearchSemanticDisabled({ SEARCH_SEMANTIC_DISABLED: ' TRUE ' })).toBe(true);
  });

  it('keys a query by a hash of the model and its lowercased words, never by the words', () => {
    expect(normalizeSearchQueryForEmbedding('  Ocean   at\tDusk ')).toBe('ocean at dusk');
    const hash = searchQueryEmbeddingHash('ocean at dusk');
    expect(hash).toBe(createHash('sha256').update('gte-small\nocean at dusk', 'utf8').digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('ocean');
    expect(searchQueryEmbeddingHash('ocean at dawn')).not.toBe(hash);
  });
});

describe('requestSearchEmbeddings', () => {
  it('posts the ids in the search mode with the service key', async () => {
    const fetchImpl = jsonFetch(() => ({
      body: { mode: 'search', embedded: 2, skipped: 1, skipped_unsearchable: [postId(4)], deferred: [postId(5)], failed: [] },
    }));
    const result = await requestSearchEmbeddings([postId(1), postId(2)], { config: CONFIG, fetchImpl });
    expect(result).toEqual({
      ok: true, embedded: 2, skipped: 1, skippedUnsearchable: [postId(4)], deferred: [postId(5)], failed: [],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(FUNCTION_URL);
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'search', postIds: [postId(1), postId(2)] });
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` });
  });

  it('reads the answer of a function from before the modes as unsupported: it embedded the feed’s, not search’s', async () => {
    const fetchImpl = jsonFetch(() => ({ body: { embedded: 2, skipped: 0, skipped_empty: [], deferred: [], failed: [] } }));
    expect(await requestSearchEmbeddings([postId(1)], { config: CONFIG, fetchImpl })).toEqual({
      ok: false, error: 'embed-post does not know the search mode', unsupported: true,
    });
  });

  it('never throws: a refusal, an unreadable body and a network error are answers', async () => {
    expect(await requestSearchEmbeddings([postId(1)], { config: CONFIG, fetchImpl: jsonFetch(() => ({ status: 500, body: {} })) }))
      .toEqual({ ok: false, error: 'embed-post answered 500' });
    expect(await requestSearchEmbeddings([postId(1)], { config: CONFIG, fetchImpl: jsonFetch(() => ({ body: { mode: 'search', embedded: 'two' } })) }))
      .toEqual({ ok: false, error: 'embed-post answered an unreadable body' });
    expect(await requestSearchEmbeddings([postId(1)], { config: CONFIG, fetchImpl: vi.fn(async () => { throw new Error('socket closed'); }) }))
      .toEqual({ ok: false, error: 'socket closed' });
  });
});

describe('search-embeddings job', () => {
  const pruned = { post_embeddings_deleted: 2, query_embeddings_deleted: 3, query_days_deleted: 1 };

  it('has work when a post waits or something can be pruned, and none while switched off', async () => {
    for (const [row, expected] of [
      [{ pending: true, prunable: false }, true],
      [{ pending: false, prunable: true }, true],
      [{ pending: false, prunable: false }, false],
    ] as const) {
      const { client, calls } = clientWith({ search_embedding_backlog: () => ({ data: [row] }) });
      expect(await hasSearchEmbeddingWork(client, { env: ENV })).toBe(expected);
      expect(calls).toEqual([{ name: 'search_embedding_backlog', args: { p_embedding_model: 'gte-small' } }]);
    }
    const { client, calls } = clientWith({ search_embedding_backlog: () => ({ data: [{ pending: true, prunable: true }] }) });
    expect(await hasSearchEmbeddingWork(client, { env: { ...ENV, SEARCH_SEMANTIC_DISABLED: '1' } })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('sends the pending posts eight at a time, newest first as listed, then prunes', async () => {
    const pending = Array.from({ length: 19 }, (_, index) => postId(index + 1));
    const { client, calls } = clientWith({
      list_posts_pending_search_embedding: () => ({ data: pending.map((post_id) => ({ post_id })) }),
      prune_search_embeddings: () => ({ data: [pruned] }),
    });
    const fetchImpl = jsonFetch((body) => {
      const ids = body.postIds as string[];
      return {
        body: {
          mode: 'search',
          embedded: ids.length - 1,
          skipped: 0,
          skipped_unsearchable: [],
          deferred: [ids[ids.length - 1]],
          failed: [],
        },
      };
    });
    const summary = await runSearchEmbeddingJob(client, {
      now: new Date('2026-11-13T00:00:00.000Z'), env: ENV, fetchImpl, clock: () => 0,
    });
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init.body)).postIds)).toEqual([
      pending.slice(0, 8), pending.slice(8, 16), pending.slice(16),
    ]);
    expect(summary).toEqual({
      asOf: '2026-11-13T00:00:00.000Z',
      pending: 19,
      embedded: 16,
      skipped: 0,
      skippedUnsearchable: 0,
      deferred: 3,
      failed: 0,
      batches: 3,
      batchesFailed: 0,
      pruned: { postEmbeddings: 2, queryEmbeddings: 3, queryDays: 1 },
    });
    expect(calls[0]).toEqual({
      name: 'list_posts_pending_search_embedding',
      args: { p_embedding_model: 'gte-small', p_limit: SEARCH_EMBEDDING_PENDING_LIMIT },
    });
    expect(calls.at(-1)).toEqual({ name: 'prune_search_embeddings', args: { p_limit: 1_000 } });
  });

  it('asks the function for nothing when no post waits, and still prunes', async () => {
    const { client } = clientWith({
      list_posts_pending_search_embedding: () => ({ data: [] }),
      prune_search_embeddings: () => ({ data: [pruned] }),
    });
    const fetchImpl = jsonFetch(() => ({ body: {} }));
    const summary = await runSearchEmbeddingJob(client, { env: ENV, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ pending: 0, batches: 0, embedded: 0, pruned: { postEmbeddings: 2 } });
  });

  it('starts no request past its budget and leaves the rest for the next run', async () => {
    const pending = Array.from({ length: 24 }, (_, index) => postId(index + 1));
    const { client } = clientWith({
      list_posts_pending_search_embedding: () => ({ data: pending.map((post_id) => ({ post_id })) }),
      prune_search_embeddings: () => ({ data: [pruned] }),
    });
    let elapsed = 0;
    const fetchImpl = jsonFetch((body) => {
      elapsed += SEARCH_EMBEDDING_REQUEST_BUDGET_MS;
      return { body: { mode: 'search', embedded: (body.postIds as string[]).length, skipped: 0, skipped_unsearchable: [], deferred: [], failed: [] } };
    });
    const summary = await runSearchEmbeddingJob(client, { env: ENV, fetchImpl, clock: () => elapsed });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ pending: 24, embedded: 8, deferred: 16, batches: 1, failed: 0 });
  });

  it('counts a failed request and goes on, and fails the run only when every request failed', async () => {
    const pending = Array.from({ length: 16 }, (_, index) => postId(index + 1));
    const handlers: RpcHandlers = {
      list_posts_pending_search_embedding: () => ({ data: pending.map((post_id) => ({ post_id })) }),
      prune_search_embeddings: () => ({ data: [pruned] }),
    };
    let request = 0;
    const flaky = jsonFetch((body) => {
      request += 1;
      return request === 1
        ? { status: 503, body: {} }
        : { body: { mode: 'search', embedded: (body.postIds as string[]).length, skipped: 0, skipped_unsearchable: [], deferred: [], failed: [] } };
    });
    expect(await runSearchEmbeddingJob(clientWith(handlers).client, { env: ENV, fetchImpl: flaky, clock: () => 0 }))
      .toMatchObject({ embedded: 8, failed: 8, batches: 2, batchesFailed: 1 });

    const down = jsonFetch(() => ({ status: 503, body: {} }));
    await expect(runSearchEmbeddingJob(clientWith(handlers).client, { env: ENV, fetchImpl: down, clock: () => 0 }))
      .rejects.toThrow('Search embeddings could not use embed-post: all 2 request(s) failed');
  });

  it('stops at the first answer of a function from before the search mode', async () => {
    const pending = Array.from({ length: 24 }, (_, index) => postId(index + 1));
    const { client } = clientWith({
      list_posts_pending_search_embedding: () => ({ data: pending.map((post_id) => ({ post_id })) }),
      prune_search_embeddings: () => ({ data: [pruned] }),
    });
    const old = jsonFetch(() => ({ body: { embedded: 8, skipped: 0, skipped_empty: [], deferred: [], failed: [] } }));
    await expect(runSearchEmbeddingJob(client, { env: ENV, fetchImpl: old, clock: () => 0 }))
      .rejects.toThrow('all 1 request(s) failed');
    // One request, not three: every further one would be read the same way.
    expect(old).toHaveBeenCalledTimes(1);
  });

  it('refuses to run without the function’s address or key', async () => {
    const { client } = clientWith({});
    await expect(runSearchEmbeddingJob(client, { env: {} })).rejects.toThrow('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('requestQueryEmbedding', () => {
  it('posts the query in the query mode and reads the vector', async () => {
    const fetchImpl = jsonFetch(() => ({ body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }));
    expect(await requestQueryEmbedding('ocean at dusk', { config: CONFIG, fetchImpl })).toEqual({ ok: true, embedding: VECTOR });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ mode: 'query', query: 'ocean at dusk' });
  });

  it.each([
    ['a function from before the modes, which looks for post ids', { status: 400, body: { error: 'postIds must be an array of 1 to 25 post ids' } }, 'embed-post answered 400'],
    ['a vector of another width', { body: { mode: 'query', model: 'gte-small', embedding: [1, 0] } }, 'embed-post answered an unreadable body'],
    ['another model’s vector', { body: { mode: 'query', model: 'another', embedding: VECTOR } }, 'embed-post answered an unreadable body'],
    ['an answer without the mode', { body: { embedding: VECTOR } }, 'embed-post answered an unreadable body'],
  ])('answers a failure for %s', async (_label, answer, error) => {
    expect(await requestQueryEmbedding('sea', { config: CONFIG, fetchImpl: jsonFetch(() => answer) })).toEqual({ ok: false, error });
  });
});

describe('findRelatedPostRows', () => {
  const related = [
    { post_id: postId(21), creator_user_id: postId(901), similarity: 0.91 },
    { post_id: postId(22), creator_user_id: postId(902), similarity: 0.87 },
  ];
  const viewer = postId(700);
  const VIEWER_KEY = 'viewer-key-1';
  const allowed = () => vi.fn(async () => ({
    allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z',
  }));
  const refused = () => vi.fn(async () => {
    throw new BackendRateLimitError({
      allowed: false, limit: 40, remaining: 0, retryAfterSeconds: 3_600, resetAt: '2026-11-14T00:00:00.000Z',
    });
  });
  const newVector = () => jsonFetch(() => ({ body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }));
  const ask = { query: 'ocean at dusk', viewerUserId: null, viewerKey: VIEWER_KEY, excludePostIds: [] as string[] };

  function logCalls(logEvent: ReturnType<typeof vi.fn>) {
    return logEvent.mock.calls.map(([level, event, fields]) => ({ level, event, reason: (fields as { reason?: string })?.reason }));
  }

  it('reads a cached vector: nothing is counted, reserved or asked of the function', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: VECTOR_TEXT }),
      search_related_posts: () => ({ data: related }),
    });
    const fetchImpl = jsonFetch(() => ({ body: {} }));
    const enforce = allowed();
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(
      client,
      { query: 'Ocean  at Dusk', viewerUserId: viewer, viewerKey: VIEWER_KEY, excludePostIds: [postId(1), 'not-a-uuid'] },
      { env: ENV, fetchImpl, logEvent, enforceBackendRateLimit: enforce },
    );
    expect(rows).toEqual(related);
    expect(fetchImpl).not.toHaveBeenCalled();
    // A cache hit is free: it spends none of the viewer's allowance.
    expect(enforce).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        name: 'search_query_embedding',
        args: { p_query_hash: searchQueryEmbeddingHash('ocean at dusk'), p_embedding_model: 'gte-small' },
      },
      {
        name: 'search_related_posts',
        args: {
          p_query_embedding: VECTOR_TEXT,
          p_viewer_user_id: viewer,
          // Only ids reach the uuid[] parameter.
          p_exclude_post_ids: [postId(1)],
          p_limit: SEARCH_RELATED_MAX_POSTS,
          p_embedding_model: 'gte-small',
        },
      },
    ]);
    // The query's words reach the database as a hash and nothing else.
    expect(JSON.stringify(calls)).not.toMatch(/ocean|dusk/i);
  });

  it('embeds a new query in this order: the cache, the viewer’s allowance, the day’s cap, the function', async () => {
    const order: string[] = [];
    const { client, calls } = clientWith({
      search_query_embedding: () => { order.push('cache'); return { data: null }; },
      reserve_search_query_embedding: () => { order.push('day'); return { data: true }; },
      store_search_query_embedding: () => { order.push('store'); return { data: null }; },
      search_related_posts: () => { order.push('related'); return { data: related }; },
    });
    const enforce = vi.fn(async () => {
      order.push('viewer');
      return { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z' };
    });
    const fetchImpl = jsonFetch(() => {
      order.push('function');
      return { body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } };
    });
    const scheduler = heldScheduler();
    const rows = await findRelatedPostRows(client, ask, {
      env: ENV, fetchImpl, logEvent: vi.fn(), enforceBackendRateLimit: enforce, runAfterResponse: scheduler.runAfterResponse,
    });
    await scheduler.runAll();
    expect(rows).toEqual(related);
    expect(order.slice(0, 4)).toEqual(['cache', 'viewer', 'day', 'function']);
    expect([...order].sort()).toEqual(['cache', 'day', 'function', 'related', 'store', 'viewer']);
    expect(enforce).toHaveBeenCalledExactlyOnceWith(client, {
      scope: 'public-search:related-embedding', limit: 40, windowSeconds: 86_400, key: VIEWER_KEY,
    });
    expect(calls.find((call) => call.name === 'reserve_search_query_embedding')?.args)
      .toEqual({ p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ mode: 'query', query: 'ocean at dusk' });
    expect(calls.find((call) => call.name === 'store_search_query_embedding')?.args).toEqual({
      p_query_hash: searchQueryEmbeddingHash('ocean at dusk'),
      p_embedding_model: 'gte-small',
      p_embedding: VECTOR_TEXT,
    });
  });

  it('counts the allowance through the repo’s own rate limit, against the viewer’s key', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      check_backend_rate_limit: () => ({
        data: { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z' },
      }),
      reserve_search_query_embedding: () => ({ data: true }),
      store_search_query_embedding: () => ({ data: null }),
      search_related_posts: () => ({ data: related }),
    });
    expect(await findRelatedPostRows(client, ask, { env: ENV, fetchImpl: newVector(), logEvent: vi.fn() })).toEqual(related);
    expect(calls.find((call) => call.name === 'check_backend_rate_limit')?.args).toEqual({
      p_scope: 'public-search:related-embedding',
      p_subject_key: VIEWER_KEY,
      p_limit: 40,
      p_window_seconds: 86_400,
    });
  });

  it('goes without past the viewer’s allowance: nothing of the shared day is reserved and the function is not called', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
    });
    const fetchImpl = newVector();
    const logEvent = vi.fn();
    expect(await findRelatedPostRows(client, ask, {
      env: ENV, fetchImpl, logEvent, enforceBackendRateLimit: refused(),
    })).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding']);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The allowance working is not a fault: an info line, not a warning.
    expect(logCalls(logEvent)).toEqual([{ level: 'info', event: 'public_search_related_skipped', reason: 'viewer_cap_reached' }]);
  });

  it('still reads the cache for a viewer past their allowance', async () => {
    const { client } = clientWith({
      search_query_embedding: () => ({ data: VECTOR_TEXT }),
      search_related_posts: () => ({ data: related }),
    });
    const enforce = refused();
    expect(await findRelatedPostRows(client, ask, { env: ENV, logEvent: vi.fn(), enforceBackendRateLimit: enforce }))
      .toEqual(related);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('goes without past the day’s cap, asking the function for nothing', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: false }),
    });
    const fetchImpl = newVector();
    const logEvent = vi.fn();
    expect(await findRelatedPostRows(client, ask, { env: ENV, fetchImpl, logEvent, enforceBackendRateLimit: allowed() }))
      .toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding', 'reserve_search_query_embedding']);
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'daily_cap_reached' }]);
  });

  it('goes without when the allowance cannot be read: no reservation, no call', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
    });
    const fetchImpl = newVector();
    const logEvent = vi.fn();
    const failing = vi.fn(async () => { throw new Error('statement timeout'); });
    expect(await findRelatedPostRows(client, ask, { env: ENV, fetchImpl, logEvent, enforceBackendRateLimit: failing as never }))
      .toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding']);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'lookup_failed' }]);
  });

  it('hands the keep-alive to the scheduler when the read starts, before anything has answered', async () => {
    const { client } = clientWith({ search_query_embedding: () => new Promise<RpcAnswer>(() => undefined) });
    const scheduler = heldScheduler();
    const reading = findRelatedPostRows(client, ask, {
      env: ENV, logEvent: vi.fn(), enforceBackendRateLimit: allowed(), runAfterResponse: scheduler.runAfterResponse, totalTimeoutMs: 20,
    });
    // Registered in the same tick as the call: the request is certainly open.
    expect(scheduler.tasks).toHaveLength(1);
    expect(await reading).toBeNull();
    // And never again: nothing is registered once the answer may have gone.
    expect(scheduler.tasks).toHaveLength(1);
  });

  it('gives up on a slow function after the short wait, and its vector is kept when it comes', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
      store_search_query_embedding: () => ({ data: null }),
      search_related_posts: () => ({ data: related }),
    });
    let answer: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const scheduler = heldScheduler();
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(client, ask, {
      env: ENV, fetchImpl, logEvent, enforceBackendRateLimit: allowed(),
      runAfterResponse: scheduler.runAfterResponse, queryEmbeddingTimeoutMs: 5,
    });
    expect(rows).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding', 'reserve_search_query_embedding']);
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'embedding_timeout' }]);
    // The keep-alive was handed over at the start; it now waits for the late vector and its write.
    expect(scheduler.tasks).toHaveLength(1);
    const kept = scheduler.runAll();
    answer(new Response(JSON.stringify({ mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR })));
    await kept;
    expect(calls.at(-1)?.name).toBe('store_search_query_embedding');
    // Nobody is waiting for the posts any more: they are not read.
    expect(calls.map((call) => call.name)).not.toContain('search_related_posts');
  });

  describe('once the search has stopped waiting', () => {
    function abandonedAt(step: 'search_query_embedding' | 'check_backend_rate_limit' | 'reserve_search_query_embedding') {
      let release: (answer: RpcAnswer) => void = () => undefined;
      const held = () => new Promise<RpcAnswer>((resolve) => { release = resolve; });
      const answers: RpcHandlers = {
        search_query_embedding: () => ({ data: null }),
        check_backend_rate_limit: () => ({
          data: { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z' },
        }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
        store_search_query_embedding: () => ({ data: null }),
        search_related_posts: () => ({ data: related }),
      };
      const answer = answers[step];
      const { client, calls } = clientWith({ ...answers, [step]: async (args) => { await held(); return answer(args); } });
      const scheduler = heldScheduler();
      const logEvent = vi.fn();
      const fetchImpl = newVector();
      const reading = findRelatedPostRows(client, ask, {
        env: ENV, fetchImpl, logEvent, runAfterResponse: scheduler.runAfterResponse, totalTimeoutMs: 5,
      });
      return {
        calls, fetchImpl, logEvent, scheduler,
        async finish() {
          expect(await reading).toBeNull();
          // The one task registered at the start covers everything that follows.
          expect(scheduler.tasks).toHaveLength(1);
          const kept = scheduler.runAll();
          release({});
          await kept;
        },
      };
    }

    it('takes no allowance, reserves nothing and calls nothing when the cache answered too late', async () => {
      const run = abandonedAt('search_query_embedding');
      await run.finish();
      expect(run.calls.map((call) => call.name)).toEqual(['search_query_embedding']);
      expect(run.fetchImpl).not.toHaveBeenCalled();
      // Said once, by the timeout.
      expect(logCalls(run.logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'timeout' }]);
    });

    it('reserves nothing and calls nothing when the allowance answered too late', async () => {
      const run = abandonedAt('check_backend_rate_limit');
      await run.finish();
      expect(run.calls.map((call) => call.name)).toEqual(['search_query_embedding', 'check_backend_rate_limit']);
      expect(run.fetchImpl).not.toHaveBeenCalled();
      expect(logCalls(run.logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'timeout' }]);
    });

    it('gives the day’s place back and does not call the function when the reservation answered too late', async () => {
      const run = abandonedAt('reserve_search_query_embedding');
      await run.finish();
      expect(run.calls.map((call) => call.name)).toEqual([
        'search_query_embedding', 'check_backend_rate_limit', 'reserve_search_query_embedding', 'release_search_query_embedding',
      ]);
      expect(run.calls.at(-1)?.args).toEqual({ p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP });
      expect(run.fetchImpl).not.toHaveBeenCalled();
      expect(logCalls(run.logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'timeout' }]);
    });
  });

  describe('a guest session', () => {
    const GUEST_NETWORK = 'network-hash-1';
    const guestAsk = { ...ask, viewerUserId: viewer, viewerKey: 'guest-key-1', guestNetworkKey: GUEST_NETWORK };
    const refusing = (scope: string) => vi.fn(async (_client: unknown, options: { scope: string; limit: number }) => {
      if (options.scope === scope) {
        throw new BackendRateLimitError({
          allowed: false, limit: options.limit, remaining: 0, retryAfterSeconds: 3_600, resetAt: '2026-11-14T00:00:00.000Z',
        });
      }
      return { allowed: true, limit: options.limit, remaining: 1, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z' };
    });

    it('is held to 120 new queries a day on its network, three guests’ whole allowances', () => {
      expect(SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT).toEqual({
        scope: 'public-search:related-embedding-guest-network', limit: 120, windowSeconds: 86_400,
      });
      expect(SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT.limit).toBe(3 * SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT.limit);
      // Not the scope a visitor's network is counted under: the two do not eat each other's.
      expect(SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT.scope).not.toBe(SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT.scope);
      // One network's guests and visitors together cannot empty the day.
      expect(SEARCH_QUERY_EMBEDDING_GUEST_NETWORK_DAILY_LIMIT.limit + SEARCH_QUERY_EMBEDDING_VIEWER_DAILY_LIMIT.limit)
        .toBeLessThan(SEARCH_QUERY_EMBEDDING_DAILY_CAP / 10);
    });

    it('is counted against its own key, then its network, then the day', async () => {
      const order: string[] = [];
      const { client } = clientWith({
        search_query_embedding: () => { order.push('cache'); return { data: null }; },
        reserve_search_query_embedding: () => { order.push('day'); return { data: true }; },
        store_search_query_embedding: () => ({ data: null }),
        search_related_posts: () => ({ data: related }),
      });
      const enforce = vi.fn(async (_client: unknown, options: { scope: string; key: string }) => {
        order.push(`${options.scope}=${options.key}`);
        return { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-14T00:00:00.000Z' };
      });
      const fetchImpl = jsonFetch(() => {
        order.push('function');
        return { body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } };
      });
      expect(await findRelatedPostRows(client, guestAsk, {
        env: ENV, fetchImpl, logEvent: vi.fn(), enforceBackendRateLimit: enforce as never,
      })).toEqual(related);
      expect(order.slice(0, 5)).toEqual([
        'cache',
        'public-search:related-embedding=guest-key-1',
        `public-search:related-embedding-guest-network=${GUEST_NETWORK}`,
        'day',
        'function',
      ]);
      expect(enforce).toHaveBeenNthCalledWith(2, client, {
        scope: 'public-search:related-embedding-guest-network', limit: 120, windowSeconds: 86_400, key: GUEST_NETWORK,
      });
    });

    it('goes without once its network’s guests have spent theirs, whatever is left of its own', async () => {
      const { client, calls } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
      });
      const fetchImpl = newVector();
      const logEvent = vi.fn();
      // A new guest session every time: each has its own key and a whole allowance of its own.
      for (const viewerKey of ['guest-key-1', 'guest-key-2', 'guest-key-3']) {
        expect(await findRelatedPostRows(client, { ...guestAsk, viewerKey }, {
          env: ENV, fetchImpl, logEvent,
          enforceBackendRateLimit: refusing('public-search:related-embedding-guest-network') as never,
        })).toBeNull();
      }
      expect(calls.map((call) => call.name)).toEqual(Array(3).fill('search_query_embedding'));
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logCalls(logEvent)).toEqual(
        Array(3).fill({ level: 'info', event: 'public_search_related_skipped', reason: 'network_cap_reached' }),
      );
    });

    it('past its own allowance spends none of its network’s', async () => {
      const { client, calls } = clientWith({ search_query_embedding: () => ({ data: null }) });
      const enforce = refusing('public-search:related-embedding');
      const logEvent = vi.fn();
      expect(await findRelatedPostRows(client, guestAsk, { env: ENV, logEvent, enforceBackendRateLimit: enforce as never }))
        .toBeNull();
      expect(enforce).toHaveBeenCalledTimes(1);
      expect(calls.map((call) => call.name)).toEqual(['search_query_embedding']);
      expect(logCalls(logEvent)).toEqual([{ level: 'info', event: 'public_search_related_skipped', reason: 'viewer_cap_reached' }]);
    });

    it('still reads the cache for nothing, and is not looked up at all without a network to count it on', async () => {
      const { client, calls } = clientWith({
        search_query_embedding: () => ({ data: VECTOR_TEXT }),
        search_related_posts: () => ({ data: related }),
      });
      const enforce = refusing('public-search:related-embedding-guest-network');
      expect(await findRelatedPostRows(client, guestAsk, { env: ENV, logEvent: vi.fn(), enforceBackendRateLimit: enforce as never }))
        .toEqual(related);
      expect(enforce).not.toHaveBeenCalled();
      const logEvent = vi.fn();
      const before = calls.length;
      expect(await findRelatedPostRows(client, { ...guestAsk, guestNetworkKey: '  ' }, { env: ENV, logEvent })).toBeNull();
      expect(calls).toHaveLength(before);
      expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'no_viewer_key' }]);
    });

    it.each([
      ['a registered account', { ...ask, viewerUserId: viewer, viewerKey: 'account-1' }],
      ['an account whose network is given as null', { ...ask, viewerUserId: viewer, viewerKey: 'account-1', guestNetworkKey: null }],
      ['a visitor, whose key is the network already', ask],
    ])('is not %s: that one is counted by its own key only', async (_label, options) => {
      const { client } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        store_search_query_embedding: () => ({ data: null }),
        search_related_posts: () => ({ data: related }),
      });
      const enforce = allowed();
      expect(await findRelatedPostRows(client, options, {
        env: ENV, fetchImpl: newVector(), logEvent: vi.fn(), enforceBackendRateLimit: enforce,
      })).toEqual(related);
      expect(enforce).toHaveBeenCalledExactlyOnceWith(client, {
        scope: 'public-search:related-embedding', limit: 40, windowSeconds: 86_400, key: options.viewerKey,
      });
    });
  });

  describe('a request that brought no vector', () => {
    const TIMEOUT = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    it.each([
      ['a refusal', jsonFetch(() => ({ status: 503, body: { error: 'boot error' } }))],
      ['a function from before the modes', jsonFetch(() => ({ status: 400, body: { error: 'postIds must be an array' } }))],
      ['its ten seconds passing', vi.fn(async () => { throw TIMEOUT; })],
      ['a thrown error', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); })],
      ['an unreadable answer', jsonFetch(() => ({ body: { embedding: [1, 0] } }))],
    ])('gives the day’s place back, once, after %s', async (_label, fetchImpl) => {
      const { client, calls } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
      });
      const scheduler = heldScheduler();
      const logEvent = vi.fn();
      expect(await findRelatedPostRows(client, ask, {
        env: ENV, fetchImpl: fetchImpl as never, logEvent, enforceBackendRateLimit: allowed(),
        runAfterResponse: scheduler.runAfterResponse,
      })).toBeNull();
      await scheduler.runAll();
      expect(calls.map((call) => call.name)).toEqual([
        'search_query_embedding', 'reserve_search_query_embedding', 'release_search_query_embedding',
      ]);
      // The same cap the place was taken under bounds the giving back.
      expect(calls.at(-1)?.args).toEqual({ p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP });
      expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'embedding_failed' }]);
    });

    it('gives the place back behind the answer when the function failed after the short wait', async () => {
      const { client, calls } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
      });
      let fail: (error: Error) => void = () => undefined;
      const fetchImpl = vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
      const scheduler = heldScheduler();
      expect(await findRelatedPostRows(client, ask, {
        env: ENV, fetchImpl, logEvent: vi.fn(), enforceBackendRateLimit: allowed(),
        runAfterResponse: scheduler.runAfterResponse, queryEmbeddingTimeoutMs: 5,
      })).toBeNull();
      // The short wait is not a failure: the request is still out, and the place still taken.
      expect(calls.map((call) => call.name)).toEqual(['search_query_embedding', 'reserve_search_query_embedding']);
      const kept = scheduler.runAll();
      fail(TIMEOUT);
      await kept;
      expect(calls.at(-1)?.name).toBe('release_search_query_embedding');
    });

    it('keeps the place of a request that brought one', async () => {
      const { client, calls } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
        store_search_query_embedding: () => ({ data: null }),
        search_related_posts: () => ({ data: related }),
      });
      const scheduler = heldScheduler();
      expect(await findRelatedPostRows(client, ask, {
        env: ENV, fetchImpl: newVector(), logEvent: vi.fn(), enforceBackendRateLimit: allowed(),
        runAfterResponse: scheduler.runAfterResponse,
      })).toEqual(related);
      await scheduler.runAll();
      expect(calls.map((call) => call.name)).not.toContain('release_search_query_embedding');
    });

    it.each([
      ['answers an error', () => ({ error: { message: 'deadlock' } })],
      ['throws', () => { throw new Error('socket closed'); }],
    ] as Array<[string, RpcHandlers[string]]>)('never throws when the giving back %s: one warning, without the query', async (_label, release) => {
      const { client } = clientWith({
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: release,
      });
      const scheduler = heldScheduler();
      const logEvent = vi.fn();
      const secret = 'a query nobody else should read';
      expect(await findRelatedPostRows(client, { ...ask, query: secret }, {
        env: ENV, fetchImpl: jsonFetch(() => ({ status: 503, body: {} })), logEvent, enforceBackendRateLimit: allowed(),
        runAfterResponse: scheduler.runAfterResponse,
      })).toBeNull();
      await expect(scheduler.runAll()).resolves.not.toThrow();
      // One line each, whichever came first: the search's skip and the failed giving back.
      expect(logEvent.mock.calls.map(([level, event]) => `${level} ${event}`).sort()).toEqual([
        'warn public_search_related_release_failed', 'warn public_search_related_skipped',
      ]);
      expect(JSON.stringify(logEvent.mock.calls)).not.toContain(secret);
    });
  });

  it.each([
    ['the kill switch', { env: { ...ENV, SEARCH_SEMANTIC_DISABLED: '1' } }, {}, []],
    ['no function address', { env: {} }, {}, ['not_configured']],
    ['a database from before the migration', { env: ENV }, {}, ['lookup_failed']],
    ['a reservation that fails', { env: ENV },
      { search_query_embedding: () => ({ data: null }), reserve_search_query_embedding: () => ({ error: { message: 'deadlock' } }) }, ['lookup_failed']],
    ['a function from before the modes', { env: ENV, fetchImpl: jsonFetch(() => ({ status: 400, body: { error: 'postIds must be an array' } })) },
      {
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
      }, ['embedding_failed']],
    ['a function that is down', { env: ENV, fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) },
      {
        search_query_embedding: () => ({ data: null }),
        reserve_search_query_embedding: () => ({ data: true }),
        release_search_query_embedding: () => ({ data: true }),
      }, ['embedding_failed']],
    ['a related read that fails', { env: ENV },
      {
        search_query_embedding: () => ({ data: VECTOR_TEXT }),
        search_related_posts: () => ({ error: { message: 'statement timeout' } }),
      }, ['related_failed']],
    ['a client that throws', { env: ENV },
      { search_query_embedding: () => { throw new Error('socket closed'); } }, ['related_failed']],
  ] as Array<[string, Record<string, unknown>, RpcHandlers, string[]]>)('answers null and never throws under %s', async (_label, dependencies, handlers, reasons) => {
    const { client } = clientWith(handlers);
    const logEvent = vi.fn();
    const secret = 'a query nobody else should read';
    const rows = await findRelatedPostRows(
      client,
      { query: secret, viewerUserId: viewer, viewerKey: VIEWER_KEY, excludePostIds: [] },
      { logEvent, enforceBackendRateLimit: allowed(), ...dependencies },
    );
    expect(rows).toBeNull();
    expect(logCalls(logEvent).map((call) => call.reason)).toEqual(reasons);
    // Whatever is logged, the query is not in it.
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(secret);
  });

  it('does not wait on a database that hangs', async () => {
    const { client } = clientWith({ search_query_embedding: () => new Promise<RpcAnswer>(() => undefined) });
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(client, ask, { env: ENV, logEvent, totalTimeoutMs: 5 });
    expect(rows).toBeNull();
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'timeout' }]);
  });

  it('looks for nothing on a blank query or without a viewer key', async () => {
    const { client, calls } = clientWith({});
    const logEvent = vi.fn();
    expect(await findRelatedPostRows(client, { ...ask, query: '   ' }, { env: ENV, logEvent })).toBeNull();
    expect(await findRelatedPostRows(client, { ...ask, viewerKey: ' ' }, { env: ENV, logEvent })).toBeNull();
    expect(calls).toEqual([]);
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'no_viewer_key' }]);
  });
});

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  SEARCH_EMBEDDING_BATCH_SIZE,
  SEARCH_EMBEDDING_MODEL,
  SEARCH_EMBEDDING_PENDING_LIMIT,
  SEARCH_EMBEDDING_REQUEST_BUDGET_MS,
  SEARCH_QUERY_EMBEDDING_DAILY_CAP,
  SEARCH_QUERY_EMBEDDING_TIMEOUT_MS,
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

  function logCalls(logEvent: ReturnType<typeof vi.fn>) {
    return logEvent.mock.calls.map(([level, event, fields]) => ({ level, event, reason: (fields as { reason?: string })?.reason }));
  }

  it('reads a cached vector and asks the function for nothing', async () => {
    const { client, calls } = clientWith({
      search_query_embedding_lookup: () => ({ data: [{ embedding: VECTOR_TEXT, reserved: false }] }),
      search_related_posts: () => ({ data: related }),
    });
    const fetchImpl = jsonFetch(() => ({ body: {} }));
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(
      client,
      { query: 'Ocean  at Dusk', viewerUserId: viewer, excludePostIds: [postId(1), 'not-a-uuid'] },
      { env: ENV, fetchImpl, logEvent },
    );
    expect(rows).toEqual(related);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        name: 'search_query_embedding_lookup',
        args: {
          p_query_hash: searchQueryEmbeddingHash('ocean at dusk'),
          p_embedding_model: 'gte-small',
          p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP,
        },
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

  it('embeds a new query once the day’s count let it, and keeps the vector behind the answer', async () => {
    const { client, calls } = clientWith({
      search_query_embedding_lookup: () => ({ data: [{ embedding: null, reserved: true }] }),
      store_search_query_embedding: () => ({ data: null }),
      search_related_posts: () => ({ data: related }),
    });
    const fetchImpl = jsonFetch(() => ({ body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }));
    const scheduler = heldScheduler();
    const rows = await findRelatedPostRows(
      client,
      { query: 'ocean at dusk', viewerUserId: null, excludePostIds: [] },
      { env: ENV, fetchImpl, logEvent: vi.fn(), runAfterResponse: scheduler.runAfterResponse },
    );
    expect(rows).toEqual(related);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ mode: 'query', query: 'ocean at dusk' });
    // Nothing is written in front of the answer.
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding_lookup', 'search_related_posts']);
    await scheduler.runAll();
    expect(calls.at(-1)).toEqual({
      name: 'store_search_query_embedding',
      args: {
        p_query_hash: searchQueryEmbeddingHash('ocean at dusk'),
        p_embedding_model: 'gte-small',
        p_embedding: VECTOR_TEXT,
      },
    });
  });

  it('goes without past the day’s cap, asking the function for nothing', async () => {
    const { client, calls } = clientWith({
      search_query_embedding_lookup: () => ({ data: [{ embedding: null, reserved: false }] }),
    });
    const fetchImpl = jsonFetch(() => ({ body: {} }));
    const logEvent = vi.fn();
    expect(await findRelatedPostRows(client, { query: 'ocean', viewerUserId: null, excludePostIds: [] }, { env: ENV, fetchImpl, logEvent }))
      .toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding_lookup']);
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'daily_cap_reached' }]);
  });

  it('gives up on a slow function after the short wait, and keeps its vector for the next search when it comes', async () => {
    const { client, calls } = clientWith({
      search_query_embedding_lookup: () => ({ data: [{ embedding: null, reserved: true }] }),
      store_search_query_embedding: () => ({ data: null }),
      search_related_posts: () => ({ data: related }),
    });
    let answer: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const scheduler = heldScheduler();
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(
      client,
      { query: 'ocean at dusk', viewerUserId: null, excludePostIds: [] },
      { env: ENV, fetchImpl, logEvent, runAfterResponse: scheduler.runAfterResponse, queryEmbeddingTimeoutMs: 5 },
    );
    expect(rows).toBeNull();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding_lookup']);
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'embedding_timeout' }]);
    // Behind the answer the request is still out; when it lands its vector is kept.
    expect(scheduler.tasks).toHaveLength(1);
    answer(new Response(JSON.stringify({ mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR })));
    await scheduler.runAll();
    expect(calls.at(-1)?.name).toBe('store_search_query_embedding');
  });

  it.each([
    ['the kill switch', { env: { ...ENV, SEARCH_SEMANTIC_DISABLED: '1' } }, {}, []],
    ['no function address', { env: {} }, {}, ['not_configured']],
    ['a database from before the migration', { env: ENV }, {}, ['lookup_failed']],
    ['a function from before the modes', { env: ENV, fetchImpl: jsonFetch(() => ({ status: 400, body: { error: 'postIds must be an array' } })) },
      { search_query_embedding_lookup: () => ({ data: [{ embedding: null, reserved: true }] }) }, ['embedding_failed']],
    ['a function that is down', { env: ENV, fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) },
      { search_query_embedding_lookup: () => ({ data: [{ embedding: null, reserved: true }] }) }, ['embedding_failed']],
    ['a related read that fails', { env: ENV },
      {
        search_query_embedding_lookup: () => ({ data: [{ embedding: VECTOR_TEXT, reserved: false }] }),
        search_related_posts: () => ({ error: { message: 'statement timeout' } }),
      }, ['related_failed']],
    ['a client that throws', { env: ENV },
      { search_query_embedding_lookup: () => { throw new Error('socket closed'); } }, ['related_failed']],
  ] as Array<[string, Record<string, unknown>, RpcHandlers, string[]]>)('answers null and never throws under %s', async (_label, dependencies, handlers, reasons) => {
    const { client } = clientWith(handlers);
    const logEvent = vi.fn();
    const secret = 'a query nobody else should read';
    const rows = await findRelatedPostRows(
      client,
      { query: secret, viewerUserId: viewer, excludePostIds: [] },
      { logEvent, ...dependencies },
    );
    expect(rows).toBeNull();
    expect(logCalls(logEvent).map((call) => call.reason)).toEqual(reasons);
    // Whatever is logged, the query is not in it.
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(secret);
  });

  it('does not wait on a database that hangs', async () => {
    const { client } = clientWith({ search_query_embedding_lookup: () => new Promise<RpcAnswer>(() => undefined) });
    const logEvent = vi.fn();
    const rows = await findRelatedPostRows(
      client,
      { query: 'ocean', viewerUserId: null, excludePostIds: [] },
      { env: ENV, logEvent, totalTimeoutMs: 5 },
    );
    expect(rows).toBeNull();
    expect(logCalls(logEvent)).toEqual([{ level: 'warn', event: 'public_search_related_skipped', reason: 'timeout' }]);
  });

  it('looks for nothing on a blank query', async () => {
    const { client, calls } = clientWith({});
    expect(await findRelatedPostRows(client, { query: '   ', viewerUserId: null, excludePostIds: [] }, { env: ENV, logEvent: vi.fn() }))
      .toBeNull();
    expect(calls).toEqual([]);
  });
});

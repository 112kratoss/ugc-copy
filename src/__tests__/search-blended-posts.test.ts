import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  blendedCursorPlace,
  isBlendedPage,
  loadBlendedPostRows,
  type BlendedPostRow,
  type BlendedPostsInput,
} from '@/lib/search-blended-posts';
import {
  SEARCH_BLEND_QUERY_EMBEDDING_TIMEOUT_MS,
  SEARCH_QUERY_EMBEDDING_DAILY_CAP,
  SEARCH_QUERY_EMBEDDING_TIMEOUT_MS,
  createSearchQueryVectors,
  findSearchQueryEmbedding,
  searchQueryEmbeddingHash,
} from '@/lib/search-embeddings';

// The server half of the blended Posts order: when search_blended_posts is
// called, with which vector, and what the caller gets when it cannot be. The
// database's part is supabase/tests/database/search_blended_posts.test.sql.

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
};
const VECTOR = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
const VECTOR_TEXT = `[${VECTOR.join(',')}]`;
const AS_OF = new Date('2026-11-15T10:00:00.000Z');
const POST = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

function jsonFetch(answer: () => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
    const result = await answer();
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  });
}

function heldScheduler() {
  const tasks: Array<() => Promise<unknown>> = [];
  return {
    runAfterResponse: (task: () => Promise<unknown>) => { tasks.push(task); },
    async runAll() { for (const task of tasks.splice(0)) await task(); },
  };
}

function dbRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    post_id: POST(n),
    creator_user_id: POST(900 + n),
    search_score: 20 - n,
    created_at: '2026-11-10T06:00:00.123456+00:00',
    corrected_query: null,
    blend_state: 'fused',
    matched_by: 'words',
    blend_position: n,
    in_window: true,
    floor_score: 20 - n,
    floor_post_id: POST(n),
    ...overrides,
  };
}

const input: BlendedPostsInput = {
  query: 'Ocean  at Dusk',
  viewerUserId: POST(700),
  viewerKey: 'viewer-key-1',
  guestNetworkKey: null,
  asOf: AS_OF,
  after: null,
  limit: 21,
  filters: { madeWith: 'model:kling-2.6', mediaKind: 'video', hasRecipe: true, following: false },
};

const blendArgs = (overrides: Record<string, unknown> = {}) => ({
  p_query: 'Ocean  at Dusk',
  // The cache key is of the query as it is embedded: lowercased, one space between words.
  p_query_hash: searchQueryEmbeddingHash('ocean at dusk'),
  p_query_embedding: null,
  p_viewer_user_id: POST(700),
  p_as_of: '2026-11-15T10:00:00.000Z',
  p_after_position: 0,
  p_limit: 21,
  p_made_with: 'model:kling-2.6',
  p_media_kind: 'video',
  p_has_recipe: true,
  p_followed_only: false,
  p_embedding_model: 'gte-small',
  p_after_post_id: null,
  ...overrides,
});

describe('loadBlendedPostRows', () => {
  it('reads a blended first page in one call when the query\'s vector is cached', async () => {
    const { client, calls } = clientWith({
      search_blended_posts: () => ({ data: [dbRow(1, { matched_by: 'both' }), dbRow(2, { matched_by: 'meaning', search_score: null })] }),
    });
    const find = vi.fn();
    const rows = await loadBlendedPostRows(client, input, { env: ENV, findSearchQueryEmbedding: find as never, logEvent: vi.fn() });

    expect(calls).toEqual([{ name: 'search_blended_posts', args: blendArgs() }]);
    expect(find).not.toHaveBeenCalled();
    expect(rows?.map((row) => [row.post_id, row.matched_by, row.search_score])).toEqual([
      [POST(1), 'both', 19],
      [POST(2), 'meaning', null],
    ]);
    expect(isBlendedPage(rows)).toBe(true);
    // The query's words reach the database for the word search and nowhere else as text.
    expect(JSON.stringify(calls[0].args.p_query_hash)).not.toMatch(/ocean|dusk/i);
  });

  it('asks for a vector when the cache has none, and reads the page again with it', async () => {
    const { client, calls } = clientWith({
      search_blended_posts: (args) => ({
        data: args.p_query_embedding === null
          ? [dbRow(1, { blend_state: 'no_vector', in_window: false })]
          : [dbRow(1, { matched_by: 'both' }), dbRow(2, { matched_by: 'meaning', search_score: null })],
      }),
    });
    const find = vi.fn<(...args: unknown[]) => Promise<number[]>>(async () => VECTOR);
    const scheduler = heldScheduler();
    const logEvent = vi.fn();
    const rows = await loadBlendedPostRows(client, input, {
      env: ENV, findSearchQueryEmbedding: find as never, logEvent, runAfterResponse: scheduler.runAfterResponse,
    });

    expect(find).toHaveBeenCalledExactlyOnceWith(
      client,
      { query: 'Ocean  at Dusk', viewerKey: 'viewer-key-1', guestNetworkKey: null },
      { env: ENV, logEvent, runAfterResponse: scheduler.runAfterResponse },
    );
    // What the caller hands over for the lookup reaches it: the request's shared lookups.
    const queryVectors = { lookup: vi.fn() };
    await loadBlendedPostRows(client, input, {
      env: ENV, findSearchQueryEmbedding: find as never, logEvent, queryVector: { queryVectors },
    });
    expect(find.mock.calls.at(-1)).toEqual([
      client,
      { query: 'Ocean  at Dusk', viewerKey: 'viewer-key-1', guestNetworkKey: null },
      { env: ENV, logEvent, runAfterResponse: undefined, queryVectors },
    ]);
    expect(calls.map((call) => call.args.p_query_embedding)).toEqual([null, VECTOR_TEXT, null, VECTOR_TEXT]);
    expect(rows?.map((row) => row.matched_by)).toEqual(['both', 'meaning']);
  });

  it('answers with the word-order page in hand when no vector comes in time', async () => {
    const { client, calls } = clientWith({
      search_blended_posts: () => ({ data: [dbRow(1, { blend_state: 'no_vector', in_window: false })] }),
    });
    const rows = await loadBlendedPostRows(client, input, {
      env: ENV, findSearchQueryEmbedding: vi.fn(async () => null) as never, logEvent: vi.fn(),
    });
    expect(calls).toHaveLength(1);
    expect(rows?.map((row) => [row.post_id, row.blend_state])).toEqual([[POST(1), 'no_vector']]);
    expect(isBlendedPage(rows)).toBe(false);
  });

  it('asks for a vector for a search no post holds the words of: that is where meaning helps most', async () => {
    const { client, calls } = clientWith({
      search_blended_posts: (args) => ({
        data: args.p_query_embedding === null ? [] : [dbRow(1, { matched_by: 'meaning', search_score: null, floor_score: null, floor_post_id: null })],
      }),
    });
    const rows = await loadBlendedPostRows(client, input, {
      env: ENV, findSearchQueryEmbedding: vi.fn(async () => VECTOR) as never, logEvent: vi.fn(),
    });
    expect(calls).toHaveLength(2);
    expect(rows?.map((row) => [row.matched_by, row.floor_post_id])).toEqual([['meaning', null]]);
  });

  it('asks for no vector for a query the word search read corrected', async () => {
    const { client } = clientWith({
      search_blended_posts: () => ({ data: [dbRow(1, { blend_state: 'corrected', corrected_query: 'ocean at dusk', in_window: false })] }),
    });
    const find = vi.fn();
    const rows = await loadBlendedPostRows(client, input, { env: ENV, findSearchQueryEmbedding: find as never, logEvent: vi.fn() });
    expect(find).not.toHaveBeenCalled();
    expect(rows?.[0]).toMatchObject({ blend_state: 'corrected', corrected_query: 'ocean at dusk' });
  });

  it('keeps the word-order page when the second read fails', async () => {
    let reads = 0;
    const { client } = clientWith({
      search_blended_posts: () => {
        reads += 1;
        return reads === 1
          ? { data: [dbRow(1, { blend_state: 'no_vector', in_window: false })] }
          : { error: { message: 'canceling statement due to statement timeout' } };
      },
    });
    const logEvent = vi.fn();
    const rows = await loadBlendedPostRows(client, input, {
      env: ENV, findSearchQueryEmbedding: vi.fn(async () => VECTOR) as never, logEvent,
    });
    expect(rows?.map((row) => row.blend_state)).toEqual(['no_vector']);
    expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_blend_failed', expect.anything());
  });

  it('reads a later page from the cache alone: its place is sent, and nothing is embedded for a page', async () => {
    const { client, calls } = clientWith({ search_blended_posts: () => ({ data: [dbRow(21), dbRow(22)] }) });
    const find = vi.fn();
    const after = { version: 1 as const, type: 'posts' as const, score: 13.18, id: POST(9), asOf: AS_OF.getTime(), window: 20, last: POST(31) };
    const rows = await loadBlendedPostRows(client, { ...input, after }, { env: ENV, findSearchQueryEmbedding: find as never, logEvent: vi.fn() });
    // Its place, and the post shown last, by which the database finds the place again if the list moved.
    expect(calls).toEqual([{ name: 'search_blended_posts', args: blendArgs({ p_after_position: 20, p_after_post_id: POST(31) }) }]);
    expect(rows).toHaveLength(2);

    const empty = clientWith({ search_blended_posts: () => ({ data: [] }) });
    expect(await loadBlendedPostRows(empty.client, { ...input, after }, { env: ENV, findSearchQueryEmbedding: find as never, logEvent: vi.fn() }))
      .toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('answers null, with a line in the log, when the read fails: the caller reads the word order', async () => {
    const { client } = clientWith({ search_blended_posts: () => ({ error: { code: 'PGRST202', message: 'no function' } }) });
    const logEvent = vi.fn();
    expect(await loadBlendedPostRows(client, input, { env: ENV, logEvent })).toBeNull();
    expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_blend_failed', expect.anything());
    // Never with the query.
    expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(/ocean|dusk/i);
  });

  it.each(['1', 'true', ' TRUE '])('reads nothing at all while SEARCH_SEMANTIC_DISABLED=%s', async (value) => {
    const { client, calls } = clientWith({ search_blended_posts: () => ({ data: [dbRow(1)] }) });
    expect(await loadBlendedPostRows(client, input, { env: { ...ENV, SEARCH_SEMANTIC_DISABLED: value }, logEvent: vi.fn() })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('drops a row it cannot read rather than guess at it', async () => {
    const { client } = clientWith({
      search_blended_posts: () => ({ data: [dbRow(1), dbRow(2, { matched_by: 'vector' }), dbRow(3, { blend_state: 'mixed' }), { post_id: 7 }] }),
    });
    const rows = await loadBlendedPostRows(client, input, { env: ENV, logEvent: vi.fn() });
    expect(rows?.map((row) => row.post_id)).toEqual([POST(1)]);
  });
});

describe('blendedCursorPlace', () => {
  const row = (overrides: Partial<BlendedPostRow>): BlendedPostRow => ({ ...dbRow(4), ...overrides } as BlendedPostRow);

  it('is the floor, the place and the post shown last while the next row is inside the window', () => {
    expect(blendedCursorPlace(row({ floor_score: 18, floor_post_id: POST(2) }), row({ blend_position: 5 })))
      .toEqual({ score: 18, id: POST(2), window: 4, last: POST(4) });
  });

  it('is the floor alone once the next row is past the window', () => {
    expect(blendedCursorPlace(row({}), row({ in_window: false }))).toEqual({ score: 16, id: POST(4) });
    expect(blendedCursorPlace(row({}), undefined)).toEqual({ score: 16, id: POST(4) });
  });

  it('names no post where there is no floor, so a cursor is never left a meaning-only post\'s id', () => {
    const place = blendedCursorPlace(row({ floor_score: null, floor_post_id: null }), row({ blend_position: 5 }));
    expect(place).toEqual({ score: undefined, id: undefined, window: 4, last: POST(4) });
    expect({ id: POST(4), ...place }.id).toBeUndefined();
  });
});

describe('findSearchQueryEmbedding', () => {
  type Allowance = { allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number; resetAt: string };
  const allowed = () => vi.fn<(client: unknown, limit: { scope: string; key: string }) => Promise<Allowance>>(async () => ({
    allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-16T00:00:00.000Z',
  }));
  const ask = { query: 'Ocean  at Dusk', viewerKey: 'viewer-key-1' };
  const newVector = () => jsonFetch(() => ({ body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }));

  it('waits a third of what related posts allow', () => {
    expect(SEARCH_BLEND_QUERY_EMBEDDING_TIMEOUT_MS).toBe(400);
    expect(SEARCH_BLEND_QUERY_EMBEDDING_TIMEOUT_MS).toBeLessThan(SEARCH_QUERY_EMBEDDING_TIMEOUT_MS);
  });

  it('reads a cached vector: nothing is counted, reserved or asked of the function', async () => {
    const { client, calls } = clientWith({ search_query_embedding: () => ({ data: VECTOR_TEXT }) });
    const fetchImpl = newVector();
    const enforce = allowed();
    expect(await findSearchQueryEmbedding(client, ask, { env: ENV, fetchImpl, enforceBackendRateLimit: enforce, logEvent: vi.fn() }))
      .toEqual(VECTOR);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(enforce).not.toHaveBeenCalled();
    expect(calls).toEqual([{
      name: 'search_query_embedding',
      args: { p_query_hash: searchQueryEmbeddingHash('ocean at dusk'), p_embedding_model: 'gte-small' },
    }]);
  });

  it('embeds a new query under the allowance related posts use, and keeps its vector', async () => {
    const order: string[] = [];
    const { client, calls } = clientWith({
      search_query_embedding: () => { order.push('cache'); return { data: null }; },
      reserve_search_query_embedding: () => { order.push('day'); return { data: true }; },
      store_search_query_embedding: () => { order.push('store'); return { data: null }; },
    });
    const enforce = vi.fn(async () => {
      order.push('viewer');
      return { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-16T00:00:00.000Z' };
    });
    const fetchImpl = jsonFetch(() => { order.push('function'); return { body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }; });
    const scheduler = heldScheduler();
    const vector = await findSearchQueryEmbedding(client, ask, {
      env: ENV, fetchImpl, enforceBackendRateLimit: enforce, logEvent: vi.fn(), runAfterResponse: scheduler.runAfterResponse,
    });
    await scheduler.runAll();
    expect(vector).toEqual(VECTOR);
    expect(order).toEqual(['cache', 'viewer', 'day', 'function', 'store']);
    expect(enforce).toHaveBeenCalledExactlyOnceWith(client, {
      scope: 'public-search:related-embedding', limit: 40, windowSeconds: 86_400, key: 'viewer-key-1',
    });
    expect(calls.find((call) => call.name === 'reserve_search_query_embedding')?.args).toEqual({ p_daily_cap: SEARCH_QUERY_EMBEDDING_DAILY_CAP });
  });

  it('counts a guest session against its network too', async () => {
    const { client } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
      store_search_query_embedding: () => ({ data: null }),
    });
    const enforce = allowed();
    await findSearchQueryEmbedding(client, { ...ask, guestNetworkKey: 'network-key' }, {
      env: ENV, fetchImpl: newVector(), enforceBackendRateLimit: enforce, logEvent: vi.fn(),
    });
    expect(enforce.mock.calls.map(([, limit]) => [limit.scope, limit.key])).toEqual([
      ['public-search:related-embedding', 'viewer-key-1'],
      ['public-search:related-embedding-guest-network', 'network-key'],
    ]);
  });

  it('answers null past the viewer\'s allowance, as a note and not a warning', async () => {
    const { client, calls } = clientWith({ search_query_embedding: () => ({ data: null }) });
    const refused = vi.fn(async () => {
      throw new BackendRateLimitError({ allowed: false, limit: 40, remaining: 0, retryAfterSeconds: 3_600, resetAt: '2026-11-16T00:00:00.000Z' });
    });
    const logEvent = vi.fn();
    const fetchImpl = newVector();
    expect(await findSearchQueryEmbedding(client, ask, { env: ENV, fetchImpl, enforceBackendRateLimit: refused as never, logEvent })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(['search_query_embedding']);
    expect(logEvent).toHaveBeenCalledExactlyOnceWith('info', 'public_search_blend_skipped', { reason: 'viewer_cap_reached' });
  });

  it('answers null past the day\'s cap', async () => {
    const { client } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: false }),
    });
    const logEvent = vi.fn();
    expect(await findSearchQueryEmbedding(client, ask, { env: ENV, fetchImpl: newVector(), enforceBackendRateLimit: allowed(), logEvent })).toBeNull();
    expect(logEvent).toHaveBeenCalledExactlyOnceWith('warn', 'public_search_blend_skipped', { reason: 'daily_cap_reached' });
  });

  it('stops waiting at its bound, and the late vector is still kept for the next search', async () => {
    let release: (() => void) | undefined;
    const stored: string[] = [];
    const { client } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
      store_search_query_embedding: (args) => { stored.push(String(args.p_query_hash)); return { data: null }; },
    });
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR }));
    });
    const scheduler = heldScheduler();
    const logEvent = vi.fn();
    const vector = await findSearchQueryEmbedding(client, ask, {
      env: ENV, fetchImpl: fetchImpl as never, enforceBackendRateLimit: allowed(), logEvent,
      runAfterResponse: scheduler.runAfterResponse, queryEmbeddingTimeoutMs: 10,
    });
    expect(vector).toBeNull();
    expect(logEvent.mock.calls.map(([, event, fields]) => [event, (fields as { reason: string }).reason]))
      .toEqual([['public_search_blend_skipped', 'embedding_timeout']]);
    release?.();
    await scheduler.runAll();
    expect(stored).toEqual([searchQueryEmbeddingHash('ocean at dusk')]);
  });

  it('answers null with the kill switch on, with no read and no line in the log', async () => {
    const { client, calls } = clientWith({});
    const logEvent = vi.fn();
    expect(await findSearchQueryEmbedding(client, ask, { env: { ...ENV, SEARCH_SEMANTIC_DISABLED: '1' }, logEvent })).toBeNull();
    expect(calls).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('goes on with a lookup it stopped waiting for, so an allowance is never spent without its request', async () => {
    // The wait runs out while the allowance is still being counted: the
    // lookup goes on, takes the day's place and asks the function, and the
    // vector is kept. The next search of these words finds it in the cache.
    let counted: () => void = () => undefined;
    const order: string[] = [];
    const { client } = clientWith({
      search_query_embedding: () => { order.push('cache'); return { data: null }; },
      reserve_search_query_embedding: () => { order.push('day'); return { data: true }; },
      store_search_query_embedding: () => { order.push('store'); return { data: null }; },
    });
    const enforce = vi.fn(async () => {
      order.push('viewer');
      await new Promise<void>((resolve) => { counted = resolve; });
      return { allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-16T00:00:00.000Z' };
    });
    const fetchImpl = jsonFetch(() => { order.push('function'); return { body: { mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR } }; });
    const scheduler = heldScheduler();
    const logEvent = vi.fn();
    expect(await findSearchQueryEmbedding(client, ask, {
      env: ENV, fetchImpl, enforceBackendRateLimit: enforce as never, logEvent,
      runAfterResponse: scheduler.runAfterResponse, queryEmbeddingTimeoutMs: 10,
    })).toBeNull();
    expect(order).toEqual(['cache', 'viewer']);
    expect(logEvent).toHaveBeenCalledExactlyOnceWith('warn', 'public_search_blend_skipped', { reason: 'embedding_timeout' });
    const kept = scheduler.runAll();
    counted();
    await kept;
    expect(order).toEqual(['cache', 'viewer', 'day', 'function', 'store']);
  });

  it('shares one lookup between everything that asks through the same request\'s lookups', async () => {
    const { client, calls } = clientWith({
      search_query_embedding: () => ({ data: null }),
      reserve_search_query_embedding: () => ({ data: true }),
      store_search_query_embedding: () => ({ data: null }),
    });
    const enforce = allowed();
    const fetchImpl = newVector();
    const queryVectors = createSearchQueryVectors(client, { viewerKey: 'viewer-key-1' }, { env: ENV, fetchImpl, enforceBackendRateLimit: enforce, logEvent: vi.fn() });
    const [first, second, other] = await Promise.all([
      findSearchQueryEmbedding(client, ask, { queryVectors, logEvent: vi.fn() }),
      findSearchQueryEmbedding(client, { ...ask, query: ' ocean at   DUSK ' }, { queryVectors, logEvent: vi.fn() }),
      findSearchQueryEmbedding(client, { ...ask, query: 'another search' }, { queryVectors, logEvent: vi.fn() }),
    ]);
    expect(first).toEqual(VECTOR);
    expect(second).toEqual(VECTOR);
    expect(other).toEqual(VECTOR);
    // Two query texts: two lookups, however many asked.
    expect(enforce).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls.filter((call) => call.name === 'search_query_embedding')).toHaveLength(2);
  });

  it('answers null for a request counted against nobody', async () => {
    const { client, calls } = clientWith({});
    expect(await findSearchQueryEmbedding(client, { ...ask, viewerKey: ' ' }, { env: ENV, logEvent: vi.fn() })).toBeNull();
    expect(await findSearchQueryEmbedding(client, { ...ask, guestNetworkKey: '' }, { env: ENV, logEvent: vi.fn() })).toBeNull();
    expect(calls).toEqual([]);
  });
});

import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SEARCH_QUERY_EVENTS_TABLE,
  buildSearchQueryEventRow,
  isSearchQueryLogDisabled,
  recordSearchAnswer,
} from '@/lib/public-search-query-log';
import type { PublicSearchResponse } from '@/lib/public-search';

const NOW = new Date('2026-11-12T10:30:00.000Z');
const RAW_KEY = 'user-1111-2222-3333';
const RAW_NETWORK_KEY = 'network-hash-of-a-visitor';

function answer(counts: { creators?: number; posts?: number; recipes?: number } = {}): PublicSearchResponse {
  const items = (count = 0) => ({ items: Array.from({ length: count }, (_, index) => ({ id: index }) as never), nextCursor: null });
  return {
    query: 'Port',
    normalizedQuery: 'Port',
    type: 'top',
    sort: 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: items(counts.creators),
    posts: items(counts.posts),
    recipes: items(counts.recipes),
  };
}

const DAY_KEY = 'c'.repeat(64);

function setup(overrides: {
  insert?: () => Promise<{ error: unknown }>;
  rpc?: () => Promise<{ data: unknown; error: unknown }>;
  env?: Record<string, string | undefined>;
} = {}) {
  const insert = vi.fn(overrides.insert ?? (async () => ({ error: null })));
  const from = vi.fn(() => ({ insert }));
  const rpc = vi.fn(overrides.rpc ?? (async () => ({ data: DAY_KEY, error: null })));
  const tasks: Array<() => Promise<unknown>> = [];
  const logEvent = vi.fn();
  const deps = {
    createClient: () => ({ from, rpc }) as unknown as SupabaseClient,
    runAfterResponse: (task: () => Promise<unknown>) => { tasks.push(task); },
    logEvent,
    env: overrides.env ?? {},
    keyCache: new Map(),
  };
  return { deps, insert, from, rpc, tasks, logEvent };
}

const input = {
  hasCursor: false,
  normalizedQuery: 'Port',
  type: 'top' as const,
  sort: 'top' as const,
  viewerKey: RAW_NETWORK_KEY,
  signedIn: false,
  requestedAt: NOW,
  response: answer({ posts: 2, recipes: 1 }),
};

describe('buildSearchQueryEventRow', () => {
  it('holds the lowercased query, type, flag, counts, arrival time and a visitor-day hash, and nothing else', () => {
    const row = buildSearchQueryEventRow(input, DAY_KEY);
    expect(row).toEqual({
      created_at: '2026-11-12T10:30:00.000Z',
      query: 'port',
      search_type: 'top',
      signed_in: false,
      visitor_day: expect.stringMatching(/^[0-9a-f]{64}$/),
      creator_count: 0,
      post_count: 2,
      recipe_count: 1,
      sort: null,
      // Top is not narrowed; its posts and recipes were found on the query as typed.
      made_with: null,
      media_kind: null,
      has_recipe: null,
      followed_only: null,
      corrected: false,
      // No related posts were looked for.
      related_count: null,
    });
  });

  it('says how many related posts the answer added: 0 when none passed, null when none were looked for', () => {
    const read = (related: PublicSearchResponse['related']) => (
      buildSearchQueryEventRow({ ...input, response: { ...answer({ posts: 2 }), ...(related ? { related } : {}) } }, DAY_KEY)?.related_count
    );
    expect(read(undefined)).toBeNull();
    expect(read({ posts: [] })).toBe(0);
    expect(read({ posts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never })).toBe(3);
    // The posts the search itself found are counted apart, as before.
    expect(buildSearchQueryEventRow({
      ...input, response: { ...answer({ posts: 2 }), related: { posts: [{ id: 'a' }] as never } },
    }, DAY_KEY)).toMatchObject({ post_count: 2, related_count: 1 });
  });

  it('says what narrowed a Posts search, and nothing of filters for any other type', () => {
    const filters = { madeWith: 'model:kling-2.6', mediaKind: 'video' as const, hasRecipe: true, following: true };
    expect(buildSearchQueryEventRow({ ...input, type: 'posts', filters }, DAY_KEY)).toMatchObject({
      made_with: 'model:kling-2.6', media_kind: 'video', has_recipe: true, followed_only: true,
    });
    // A filter that is off is null, never false: the column says a search was narrowed.
    expect(buildSearchQueryEventRow({
      ...input, type: 'posts', filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    }, DAY_KEY)).toMatchObject({ made_with: null, media_kind: null, has_recipe: null, followed_only: null });
    for (const type of ['top', 'creators', 'recipes'] as const) {
      expect(buildSearchQueryEventRow({ ...input, type, filters }, DAY_KEY), type).toMatchObject({
        made_with: null, media_kind: null, has_recipe: null, followed_only: null,
      });
    }
  });

  it('says whether the posts or recipes were found on a corrected reading; a Creators search has none', () => {
    const read = (correctedQuery: PublicSearchResponse['correctedQuery'], type: PublicSearchResponse['type'] = 'top') => (
      buildSearchQueryEventRow({ ...input, type, response: { ...answer({ posts: 2 }), correctedQuery } }, DAY_KEY)?.corrected
    );
    expect(read({ posts: null, recipes: null })).toBe(false);
    expect(read({ posts: 'portrait', recipes: null })).toBe(true);
    expect(read({ posts: null, recipes: 'portrait' }, 'recipes')).toBe(true);
    expect(read({ posts: 'portrait', recipes: null }, 'creators')).toBeNull();
  });

  it('says which order a Posts or Recipes search was read in, and nothing for Top and Creators', () => {
    const sortOf = (type: 'top' | 'creators' | 'posts' | 'recipes', sort: 'top' | 'latest') => (
      buildSearchQueryEventRow({ ...input, type, sort }, DAY_KEY)?.sort
    );
    expect(sortOf('posts', 'latest')).toBe('latest');
    expect(sortOf('posts', 'top')).toBe('top');
    expect(sortOf('recipes', 'latest')).toBe('latest');
    // One order each: the column stays empty whatever the request named.
    expect(sortOf('top', 'latest')).toBeNull();
    expect(sortOf('creators', 'latest')).toBeNull();
  });

  it('never carries the raw viewer key, the user id or the network key', () => {
    for (const viewerKey of [RAW_KEY, RAW_NETWORK_KEY]) {
      const row = buildSearchQueryEventRow({ ...input, viewerKey }, DAY_KEY);
      expect(JSON.stringify(row)).not.toContain(viewerKey);
    }
  });

  it('is an HMAC under the day key: one visitor, one value per key; another key, another value', () => {
    const first = buildSearchQueryEventRow(input, DAY_KEY);
    const again = buildSearchQueryEventRow({ ...input, requestedAt: new Date('2026-11-12T23:59:59.000Z') }, DAY_KEY);
    const nextDay = buildSearchQueryEventRow(input, 'd'.repeat(64));
    const otherVisitor = buildSearchQueryEventRow({ ...input, viewerKey: 'someone-else' }, DAY_KEY);
    expect(again?.visitor_day).toBe(first?.visitor_day);
    expect(nextDay?.visitor_day).not.toBe(first?.visitor_day);
    expect(otherVisitor?.visitor_day).not.toBe(first?.visitor_day);
    expect(first?.visitor_day).toBe(createHmac('sha256', DAY_KEY).update(RAW_NETWORK_KEY).digest('hex'));
  });

  it('writes a fresh random value, never a hash under another secret, when the day key is unknown', () => {
    const first = buildSearchQueryEventRow(input, null);
    const second = buildSearchQueryEventRow(input, null);
    expect(first?.visitor_day).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.visitor_day).not.toBe(second?.visitor_day);
  });

  it('caps the query at 100 characters by code point and drops a blank one', () => {
    const long = buildSearchQueryEventRow({ ...input, normalizedQuery: '😀'.repeat(150) }, DAY_KEY);
    expect(Array.from(long?.query ?? '')).toHaveLength(100);
    expect(buildSearchQueryEventRow({ ...input, normalizedQuery: '   ' }, DAY_KEY)).toBeNull();
  });

  it('strips control characters before the cap: an ANSI or OSC sequence cannot reach the log', () => {
    const row = buildSearchQueryEventRow({ ...input, normalizedQuery: 'po\u001b[31mrt\u0007\u001b]0;pwned\u0007' }, DAY_KEY);
    expect(row?.query).toBe('po[31mrt]0;pwned');
    expect(row?.query).not.toMatch(/\p{Cc}/u);
    expect(buildSearchQueryEventRow({ ...input, normalizedQuery: '\u001b\u0007 ' }, DAY_KEY)).toBeNull();
    const padded = buildSearchQueryEventRow({ ...input, normalizedQuery: `${'\u0007'.repeat(200)}port` }, DAY_KEY);
    expect(padded?.query).toBe('port');
  });
});

describe('isSearchQueryLogDisabled', () => {
  it('is on only for 1 or true', () => {
    expect(isSearchQueryLogDisabled({ SEARCH_QUERY_LOG_DISABLED: '1' })).toBe(true);
    expect(isSearchQueryLogDisabled({ SEARCH_QUERY_LOG_DISABLED: ' TRUE ' })).toBe(true);
    expect(isSearchQueryLogDisabled({ SEARCH_QUERY_LOG_DISABLED: '0' })).toBe(false);
    expect(isSearchQueryLogDisabled({})).toBe(false);
  });
});

describe('recordSearchAnswer', () => {
  it('schedules the insert after the response and writes one row to the log table', async () => {
    const { deps, insert, from, tasks } = setup();
    recordSearchAnswer(deps, input);
    expect(tasks).toHaveLength(1);
    expect(insert).not.toHaveBeenCalled();
    await tasks[0]();
    expect(from).toHaveBeenCalledWith(SEARCH_QUERY_EVENTS_TABLE);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]).toEqual([expect.objectContaining({ query: 'port', post_count: 2 })]);
  });

  it('writes nothing for a search asked to read the query as typed: it re-asks one already counted', async () => {
    const { deps, tasks } = setup();
    recordSearchAnswer(deps, { ...input, exact: true });
    expect(tasks).toHaveLength(0);
  });

  it('reads the day key once per instance and day, and hashes under it', async () => {
    const { deps, rpc, insert, tasks } = setup();
    recordSearchAnswer(deps, input);
    recordSearchAnswer(deps, { ...input, normalizedQuery: 'Portr' });
    recordSearchAnswer(deps, { ...input, normalizedQuery: 'Portra' });
    await Promise.all(tasks.map((task) => task()));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_visitor_day_key', { p_day: '2026-11-12' });
    const hashes = (insert.mock.calls as unknown as Array<[{ visitor_day: string }]>).map(([row]) => row.visitor_day);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(createHmac('sha256', DAY_KEY).update(RAW_NETWORK_KEY).digest('hex'));

    recordSearchAnswer(deps, { ...input, requestedAt: new Date('2026-11-13T00:00:05.000Z') });
    await tasks[3]();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('logs the row with a random visitor value, not the feed salt, when the key cannot be read, and retries next time', async () => {
    const { deps, rpc, insert, tasks } = setup({ rpc: async () => ({ data: null, error: { message: 'down' } }) });
    recordSearchAnswer(deps, input);
    recordSearchAnswer(deps, input);
    await tasks[0]();
    await tasks[1]();
    expect(insert).toHaveBeenCalledTimes(2);
    const [a, b] = (insert.mock.calls as unknown as Array<[{ visitor_day: string }]>).map(([row]) => row.visitor_day);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(rpc).toHaveBeenCalledTimes(2);

    const throwing = setup({ rpc: async () => { throw new Error('network down'); } });
    recordSearchAnswer(throwing.deps, input);
    await expect(throwing.tasks[0]()).resolves.toBeUndefined();
    expect(throwing.insert).toHaveBeenCalledTimes(1);
  });

  it('stamps the row with the request time, not the time the insert runs', async () => {
    const { deps, insert, tasks } = setup();
    recordSearchAnswer(deps, input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tasks[0]();
    expect((insert.mock.calls as unknown as Array<[{ created_at: string }]>)[0][0].created_at).toBe('2026-11-12T10:30:00.000Z');
  });

  it('writes nothing for a request with a cursor (a later page)', () => {
    const { deps, tasks } = setup();
    recordSearchAnswer(deps, { ...input, hasCursor: true });
    expect(tasks).toHaveLength(0);
  });

  it('writes nothing when SEARCH_QUERY_LOG_DISABLED is set', () => {
    const { deps, tasks } = setup({ env: { SEARCH_QUERY_LOG_DISABLED: '1' } });
    recordSearchAnswer(deps, input);
    expect(tasks).toHaveLength(0);
  });

  it('logs and swallows an insert error', async () => {
    const { deps, tasks, logEvent } = setup({ insert: async () => ({ error: { message: 'boom' } }) });
    recordSearchAnswer(deps, input);
    await expect(tasks[0]()).resolves.toBeUndefined();
    expect(logEvent).toHaveBeenCalledWith('warn', 'search_query_log_failed', expect.objectContaining({ error: { message: 'boom' } }));
  });

  it('logs and swallows an insert that throws, a client that cannot be built, and a scheduler that throws', async () => {
    const throwing = setup({ insert: async () => { throw new Error('network down'); } });
    recordSearchAnswer(throwing.deps, input);
    await expect(throwing.tasks[0]()).resolves.toBeUndefined();
    expect(throwing.logEvent).toHaveBeenCalledTimes(1);

    const noClient = setup();
    recordSearchAnswer({ ...noClient.deps, createClient: () => { throw new Error('no env'); } }, input);
    await expect(noClient.tasks[0]()).resolves.toBeUndefined();
    expect(noClient.logEvent).toHaveBeenCalledTimes(1);

    const noScheduler = setup();
    expect(() => recordSearchAnswer({
      ...noScheduler.deps,
      runAfterResponse: () => { throw new Error('outside a request'); },
    }, input)).not.toThrow();
    expect(noScheduler.logEvent).toHaveBeenCalledTimes(1);
  });

  it('never logs the query text', async () => {
    const { deps, tasks, logEvent } = setup({ insert: async () => ({ error: { message: 'boom' } }) });
    recordSearchAnswer(deps, input);
    await tasks[0]();
    expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(/port/i);
  });
});

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
    creators: items(counts.creators),
    posts: items(counts.posts),
    recipes: items(counts.recipes),
  };
}

function setup(overrides: { insert?: () => Promise<{ error: unknown }>; env?: Record<string, string | undefined>; now?: Date } = {}) {
  const insert = vi.fn(overrides.insert ?? (async () => ({ error: null })));
  const from = vi.fn(() => ({ insert }));
  const tasks: Array<() => Promise<unknown>> = [];
  const logEvent = vi.fn();
  const deps = {
    createClient: () => ({ from }) as unknown as SupabaseClient,
    runAfterResponse: (task: () => Promise<unknown>) => { tasks.push(task); },
    logEvent,
    env: overrides.env ?? {},
    now: () => overrides.now ?? NOW,
  };
  return { deps, insert, from, tasks, logEvent };
}

const input = {
  hasCursor: false,
  normalizedQuery: 'Port',
  type: 'top' as const,
  viewerKey: RAW_NETWORK_KEY,
  signedIn: false,
  response: answer({ posts: 2, recipes: 1 }),
};

describe('buildSearchQueryEventRow', () => {
  it('holds the lowercased query, type, signed-in flag, counts and a visitor-day hash, and nothing else', () => {
    const row = buildSearchQueryEventRow(input, NOW);
    expect(row).toEqual({
      query: 'port',
      search_type: 'top',
      signed_in: false,
      visitor_day: expect.stringMatching(/^[0-9a-f]{64}$/),
      creator_count: 0,
      post_count: 2,
      recipe_count: 1,
    });
  });

  it('never carries the raw viewer key, the user id or the network key', () => {
    for (const viewerKey of [RAW_KEY, RAW_NETWORK_KEY]) {
      const row = buildSearchQueryEventRow({ ...input, viewerKey }, NOW);
      expect(JSON.stringify(row)).not.toContain(viewerKey);
    }
  });

  it('gives one visitor the same value all day and a different one on another day', () => {
    const morning = buildSearchQueryEventRow(input, new Date('2026-11-12T00:00:01.000Z'));
    const evening = buildSearchQueryEventRow(input, new Date('2026-11-12T23:59:59.000Z'));
    const nextDay = buildSearchQueryEventRow(input, new Date('2026-11-13T00:00:01.000Z'));
    const otherVisitor = buildSearchQueryEventRow({ ...input, viewerKey: 'someone-else' }, NOW);
    expect(morning?.visitor_day).toBe(evening?.visitor_day);
    expect(nextDay?.visitor_day).not.toBe(morning?.visitor_day);
    expect(otherVisitor?.visitor_day).not.toBe(morning?.visitor_day);
  });

  it('caps the query at 100 characters by code point and drops a blank one', () => {
    const long = buildSearchQueryEventRow({ ...input, normalizedQuery: '😀'.repeat(150) }, NOW);
    expect(Array.from(long?.query ?? '')).toHaveLength(100);
    expect(buildSearchQueryEventRow({ ...input, normalizedQuery: '   ' }, NOW)).toBeNull();
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

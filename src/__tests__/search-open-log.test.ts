import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildSearchQueryEventRow } from '@/lib/public-search-query-log';
import type { PublicSearchResponse } from '@/lib/public-search';
import {
  SEARCH_RESULT_OPENS_TABLE,
  buildSearchResultOpenRow,
  recordSearchOpen,
  searchOpenLogQuery,
} from '@/lib/search-open-log';
import {
  SEARCH_ENTRIES,
  SEARCH_OPEN_KINDS,
  SEARCH_OPEN_MAX_POSITION,
  isSearchEntry,
  readSearchEntry,
  readSearchOpenBody,
  searchEntryForChosenText,
  searchEntryParams,
  searchOpenBody,
  type SearchOpen,
} from '../../ugc-mobile/lib/public-search-policy/search-open-log';

const NOW = new Date('2026-11-15T10:30:00.000Z');
const DAY_KEY = 'c'.repeat(64);
const POST_ID = '0b9e1000-0000-4000-8000-000000000011';
const USER_KEY = 'user-1111-2222-3333';
const NETWORK_KEY = 'network-hash-of-a-visitor';

const open: SearchOpen = {
  query: 'Neon  Product',
  type: 'posts',
  sort: 'latest',
  entry: 'suggestion',
  kind: 'post',
  id: POST_ID,
  position: 3,
};

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

describe('the names the search log is told (search-open-log policy)', () => {
  it('lists the seven ways a search is entered, the database’s list', () => {
    expect([...SEARCH_ENTRIES]).toEqual(['typed', 'suggestion', 'entity', 'recent', 'starter', 'related', 'link']);
    expect(isSearchEntry('recent')).toBe(true);
    expect(isSearchEntry('voice')).toBe(false);
    // "Search instead for …" reads the same query another way: it is no entry of its own
    // (review of #826, finding 17), and a client that sent one would be refused.
    expect(isSearchEntry('correction')).toBe(false);
    expect(isSearchEntry(null)).toBe(false);
  });

  it('reads a request’s entry: none when left out, refused when unknown', () => {
    expect(readSearchEntry(null)).toEqual({ ok: true, entry: null });
    expect(readSearchEntry(undefined)).toEqual({ ok: true, entry: null });
    expect(readSearchEntry('starter')).toEqual({ ok: true, entry: 'starter' });
    expect(readSearchEntry('voice')).toEqual({ ok: false });
    expect(readSearchEntry('')).toEqual({ ok: false });
    expect(readSearchEntry('TYPED')).toEqual({ ok: false });
    expect(readSearchEntry(3)).toEqual({ ok: false });
  });

  it('names the entry in a request only when there is one', () => {
    expect(searchEntryParams('related')).toEqual({ entry: 'related' });
    expect(searchEntryParams(null)).toEqual({});
    expect(searchEntryParams(undefined)).toEqual({});
  });

  it('says how a text chosen from the typeahead was entered', () => {
    const recents = ['Neon Portrait', 'harbour'];
    // The "Search for …" row: the text already in the box.
    expect(searchEntryForChosenText('neon', ' Neon ', recents)).toBe('typed');
    expect(searchEntryForChosenText('neon portrait', 'neon', recents)).toBe('recent');
    expect(searchEntryForChosenText('neon product shots', 'neon', recents)).toBe('suggestion');
  });

  it('reads a full-width typed text as the row draws it, NFKC: its "Search for" row is typed, not a suggestion', () => {
    // The row's text is the query as the server normalizes it; the box holds what was typed.
    expect(searchEntryForChosenText('neon', '\uFF4E\uFF45\uFF4F\uFF4E', [])).toBe('typed');
    expect(searchEntryForChosenText('neon city', '\uFF4E\uFF45\uFF4F\uFF4E\u3000city', [])).toBe('typed');
    // And a recent search kept in full width is the recent one.
    expect(searchEntryForChosenText('neon harbour', 'ne', ['\uFF4E\uFF45\uFF4F\uFF4E harbour'])).toBe('recent');
  });

  it('builds the body a client posts, and nothing the server would refuse', () => {
    expect(searchOpenBody(open)).toEqual({
      q: 'Neon  Product', type: 'posts', sort: 'latest', entry: 'suggestion', kind: 'post', id: POST_ID, position: 3,
    });
    // No entry known: the field is left out, never sent as null.
    expect(searchOpenBody({ ...open, entry: null })).not.toHaveProperty('entry');
    expect(searchOpenBody({ ...open, id: POST_ID.toUpperCase() })?.id).toBe(POST_ID);
    expect(searchOpenBody({ ...open, kind: 'entity', id: 'model:kling-2.6' })?.id).toBe('model:kling-2.6');
    expect(searchOpenBody({ ...open, position: 9000 })?.position).toBe(SEARCH_OPEN_MAX_POSITION);
    expect(searchOpenBody({ ...open, position: 2.9 })?.position).toBe(2);
    for (const unsendable of [
      { ...open, query: '   ' },
      { ...open, id: 'luna-studio' },
      { ...open, id: 'model:kling-2.6' },
      { ...open, kind: 'entity' as const, id: POST_ID },
      { ...open, position: 0 },
      { ...open, position: Number.NaN },
    ]) {
      expect(searchOpenBody(unsendable), JSON.stringify(unsendable)).toBeNull();
    }
  });

  it('reads back every body it builds', () => {
    for (const kind of SEARCH_OPEN_KINDS) {
      const sent = searchOpenBody({ ...open, kind, id: kind === 'entity' ? 'tool:midjourney' : POST_ID });
      const read = readSearchOpenBody(JSON.parse(JSON.stringify(sent)));
      expect(read, kind).toEqual({
        ok: true,
        open: { ...open, kind, id: kind === 'entity' ? 'tool:midjourney' : POST_ID },
      });
    }
  });

  it('reads the tab, the order and the entry as left out, and clamps the place', () => {
    const read = readSearchOpenBody({ q: 'port', kind: 'creator', id: POST_ID, position: 7000 });
    expect(read).toEqual({
      ok: true,
      open: { query: 'port', type: 'top', sort: 'top', entry: null, kind: 'creator', id: POST_ID, position: 500 },
    });
  });

  it.each([
    ['not an object', 'port'],
    ['an array', [{ q: 'port' }]],
    ['no query', { kind: 'post', id: POST_ID, position: 1 }],
    ['a blank query', { q: '  ', kind: 'post', id: POST_ID, position: 1 }],
    ['a query of 101 characters', { q: 'x'.repeat(101), kind: 'post', id: POST_ID, position: 1 }],
    ['an unknown tab', { q: 'port', type: 'everything', kind: 'post', id: POST_ID, position: 1 }],
    ['an unknown order', { q: 'port', sort: 'oldest', kind: 'post', id: POST_ID, position: 1 }],
    ['an unknown entry', { q: 'port', entry: 'voice', kind: 'post', id: POST_ID, position: 1 }],
    ['an unknown kind', { q: 'port', kind: 'comment', id: POST_ID, position: 1 }],
    ['no kind', { q: 'port', id: POST_ID, position: 1 }],
    ['a post named by a handle', { q: 'port', kind: 'post', id: 'luna-studio', position: 1 }],
    ['a post named by a URL', { q: 'port', kind: 'post', id: 'https://magicbooklet.com/showcase/1', position: 1 }],
    ['an entity named by a uuid', { q: 'port', kind: 'entity', id: POST_ID, position: 1 }],
    ['an entity of an unknown kind', { q: 'port', kind: 'entity', id: 'brand:nike', position: 1 }],
    ['an id that is not a string', { q: 'port', kind: 'post', id: 12, position: 1 }],
    ['place zero', { q: 'port', kind: 'post', id: POST_ID, position: 0 }],
    ['a place that is not whole', { q: 'port', kind: 'post', id: POST_ID, position: 1.5 }],
    ['a place sent as text', { q: 'port', kind: 'post', id: POST_ID, position: '1' }],
  ])('refuses %s, by its shape alone', (_name, body) => {
    const read = readSearchOpenBody(body);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/\S/u);
  });

  it('counts a hundred emoji as a hundred characters, as the search does', () => {
    expect(readSearchOpenBody({ q: '🙂'.repeat(100), kind: 'post', id: POST_ID, position: 1 }).ok).toBe(true);
    expect(readSearchOpenBody({ q: '🙂'.repeat(101), kind: 'post', id: POST_ID, position: 1 }).ok).toBe(false);
  });
});

describe('buildSearchResultOpenRow', () => {
  const input = { open, viewerKey: NETWORK_KEY, requestedAt: NOW };

  it('holds the cleaned query, tab, order, entry, what was opened and a visitor-day code, and nothing else', () => {
    expect(buildSearchResultOpenRow(input, DAY_KEY)).toEqual({
      created_at: '2026-11-15T10:30:00.000Z',
      query: 'neon product',
      search_type: 'posts',
      sort: 'latest',
      entry: 'suggestion',
      visitor_day: expect.stringMatching(/^[0-9a-f]{64}$/),
      result_kind: 'post',
      result_id: POST_ID,
      result_position: 3,
    });
  });

  it('never carries the raw viewer key, the user id or the network key', () => {
    for (const viewerKey of [USER_KEY, NETWORK_KEY]) {
      expect(JSON.stringify(buildSearchResultOpenRow({ ...input, viewerKey }, DAY_KEY))).not.toContain(viewerKey);
    }
  });

  it('names an order only for Posts and Recipes, as the search row does', () => {
    const sortOf = (type: SearchOpen['type']) => buildSearchResultOpenRow({ ...input, open: { ...open, type } }, DAY_KEY)?.sort;
    expect(sortOf('posts')).toBe('latest');
    expect(sortOf('recipes')).toBe('latest');
    expect(sortOf('top')).toBeNull();
    expect(sortOf('creators')).toBeNull();
  });

  it('carries the code of the search it was opened from: same viewer, same day key, same query text', () => {
    const response: PublicSearchResponse = {
      query: 'Neon  Product',
      normalizedQuery: 'Neon Product',
      type: 'posts',
      sort: 'latest',
      entities: [],
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
      correctedQuery: { posts: null, recipes: null },
      exact: false,
      creators: { items: [], nextCursor: null },
      posts: { items: [], nextCursor: null },
      recipes: { items: [], nextCursor: null },
    };
    for (const viewerKey of [USER_KEY, NETWORK_KEY]) {
      const search = buildSearchQueryEventRow({
        normalizedQuery: 'Neon Product', type: 'posts', sort: 'latest', viewerKey, signedIn: false, requestedAt: NOW, response,
      }, DAY_KEY);
      const opened = buildSearchResultOpenRow({ ...input, viewerKey }, DAY_KEY);
      expect(opened?.visitor_day).toBe(search?.visitor_day);
      // The report joins the two on the code and the query text.
      expect(opened?.query).toBe(search?.query);
    }
    // Another viewer, or another day's key: another code.
    const mine = buildSearchResultOpenRow(input, DAY_KEY)?.visitor_day;
    expect(buildSearchResultOpenRow({ ...input, viewerKey: USER_KEY }, DAY_KEY)?.visitor_day).not.toBe(mine);
    expect(buildSearchResultOpenRow(input, 'd'.repeat(64))?.visitor_day).not.toBe(mine);
  });

  it('gets a fresh random code when the day key could not be read, never a hash under another secret', () => {
    const first = buildSearchResultOpenRow(input, null)?.visitor_day;
    const second = buildSearchResultOpenRow(input, null)?.visitor_day;
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });

  it('cleans the query exactly as the search log does: a handle’s @, control characters, case, length', () => {
    expect(searchOpenLogQuery('@Luna')).toBe('luna');
    expect(searchOpenLogQuery('po\u001b[2Jrt\u0007')).toBe('po[2jrt');
    expect(searchOpenLogQuery('  NEON   Product ')).toBe('neon product');
    expect(Array.from(searchOpenLogQuery('🙂'.repeat(150)))).toHaveLength(100);
    expect(buildSearchResultOpenRow({ ...input, open: { ...open, query: '\u0000\u0007' } }, DAY_KEY)).toBeNull();
  });
});

describe('recordSearchOpen', () => {
  const input = { open, viewerKey: NETWORK_KEY, requestedAt: NOW };

  it('schedules one insert into the opens table behind the response and returns at once', async () => {
    const { deps, insert, from, rpc, tasks } = setup();
    recordSearchOpen(deps, input);
    expect(insert).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(rpc).toHaveBeenCalledWith('search_visitor_day_key', { p_day: '2026-11-15' });
    expect(from).toHaveBeenCalledWith(SEARCH_RESULT_OPENS_TABLE);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ query: 'neon product', result_id: POST_ID, result_position: 3 }));
  });

  it.each(['1', 'true', ' TRUE '])('writes nothing when SEARCH_QUERY_LOG_DISABLED is %j: the search log’s own switch', (value) => {
    const { deps, tasks } = setup({ env: { SEARCH_QUERY_LOG_DISABLED: value } });
    recordSearchOpen(deps, input);
    expect(tasks).toHaveLength(0);
  });

  it('writes nothing for a query that is blank once cleaned', () => {
    const { deps, tasks } = setup();
    recordSearchOpen(deps, { ...input, open: { ...open, query: '\u0007' } });
    expect(tasks).toHaveLength(0);
  });

  it('never throws: a failed insert, a thrown insert, a failed client and a throwing scheduler are logged without the query or the id', async () => {
    const failing = setup({ insert: async () => ({ error: { message: 'insert refused' } }) });
    recordSearchOpen(failing.deps, input);
    await failing.tasks[0]();
    expect(failing.logEvent).toHaveBeenCalledWith('warn', 'search_open_log_failed', expect.anything());

    const throwing = setup({ insert: async () => { throw new Error('network'); } });
    recordSearchOpen(throwing.deps, input);
    await expect(throwing.tasks[0]()).resolves.toBeUndefined();
    expect(throwing.logEvent).toHaveBeenCalledTimes(1);

    const noClient = setup();
    recordSearchOpen({ ...noClient.deps, createClient: () => { throw new Error('no service key'); } }, input);
    await expect(noClient.tasks[0]()).resolves.toBeUndefined();
    expect(noClient.logEvent).toHaveBeenCalledTimes(1);

    const noScheduler = setup();
    expect(() => recordSearchOpen({
      ...noScheduler.deps,
      runAfterResponse: () => { throw new Error('outside a request'); },
    }, input)).not.toThrow();
    expect(noScheduler.logEvent).toHaveBeenCalledTimes(1);

    for (const harness of [failing, throwing, noClient, noScheduler]) {
      const logged = JSON.stringify(harness.logEvent.mock.calls);
      expect(logged).not.toContain('neon');
      expect(logged).not.toContain(POST_ID);
    }
  });

  it('still writes, under a random code, when the day key cannot be read', async () => {
    const { deps, insert, tasks } = setup({ rpc: async () => ({ data: null, error: { message: 'no' } }) });
    recordSearchOpen(deps, input);
    await tasks[0]();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ visitor_day: expect.stringMatching(/^[0-9a-f]{64}$/u) }));
  });
});

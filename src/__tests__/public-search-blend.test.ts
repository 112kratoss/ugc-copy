import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PUBLIC_SEARCH_BLEND_MAX_PLACE,
  PUBLIC_SEARCH_BLEND_PARAM,
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  publicSearchCursorFilterMark,
  type PublicSearchResponse,
} from '@/lib/public-search';
import { buildSearchQueryEventRow } from '@/lib/public-search-query-log';
import { getPublicSearchRouteResponse } from '@/lib/public-search-route-adapter-service';
import { searchPublicContent, type PublicSearchOptions } from '@/lib/public-search-service';
import type { BlendedPostRow } from '@/lib/search-blended-posts';

import {
  SEARCH_BLEND_MIN_WORDS,
  SEARCH_BLEND_PARAM,
  isSearchMeaningOnlyMatch,
  readSearchMatchedBy,
  searchBlendApplies,
  searchBlendParams,
  searchPostMatchedBy,
  searchQueryWordCount,
} from '../../ugc-mobile/lib/public-search-policy/search-blend';

const SEARCH_BEGAN = new Date('2026-11-15T10:00:00.000Z');
const POST = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function row(n: number, overrides: Partial<BlendedPostRow> = {}): BlendedPostRow {
  return {
    post_id: POST(n),
    creator_user_id: `creator-${n}`,
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

function harness({
  blended,
  wordRows = [],
}: {
  blended: BlendedPostRow[] | null | (() => BlendedPostRow[] | null);
  wordRows?: Array<{ post_id: string; creator_user_id: string; search_score: number; created_at: string; corrected_query?: string | null }>;
}) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'search_public_creators' || name === 'search_public_entities') return { data: [], error: null };
    if (name === 'search_recipes_corrected_query') return { data: null, error: null };
    if (name === 'search_public_posts') return { data: wordRows.slice(0, Number(args.p_limit)), error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const loadBlendedPostRows = vi.fn<(...args: unknown[]) => Promise<BlendedPostRow[] | null>>(
    async () => (typeof blended === 'function' ? blended() : blended),
  );
  const findRelatedPostRows = vi.fn(async () => [] as never[]);
  const search = (options: Partial<PublicSearchOptions> = {}) => searchPublicContent({
    query: 'ocean at dusk',
    normalizedQuery: 'ocean at dusk',
    type: 'posts',
    cursor: null,
    limit: 2,
    viewerUserId: 'viewer-1',
    viewerKey: 'viewer-1',
    countryCode: null,
    blend: true,
    ...options,
  }, {
    createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
    findRelatedPostRows: findRelatedPostRows as never,
    getMarketplaceResourceList: vi.fn(async () => ({
      items: [], pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
    })) as never,
    getShowcaseFeedItemsByPostIds: vi.fn(async ({ postIds }: { postIds: string[] }) => postIds.map((id) => ({ id }))) as never,
    loadBlendedPostRows: loadBlendedPostRows as never,
    loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
    logEvent: vi.fn(),
    now: () => SEARCH_BEGAN,
  });
  const wordCalls = () => rpc.mock.calls.filter(([name]) => name === 'search_public_posts').map(([, args]) => args);
  return { search, loadBlendedPostRows, findRelatedPostRows, wordCalls };
}

describe('the blended Posts order: when a search is blended', () => {
  const settled = { query: 'ocean at dusk', type: 'posts', sort: 'top', exact: false, settled: true };

  it('is a settled, ranked posts search of two words or more', () => {
    expect(SEARCH_BLEND_MIN_WORDS).toBe(2);
    expect(searchBlendApplies(settled)).toBe(true);
    expect(searchBlendApplies({ ...settled, type: 'top' })).toBe(true);
    expect(searchBlendApplies({ ...settled, query: '  ocean   at dusk ' })).toBe(true);
  });

  it.each([
    ['one word', { query: 'ocean' }],
    ['one word with spaces around it', { query: '  ocean  ' }],
    ['a handle', { query: '@luna studio' }],
    ['Latest', { sort: 'latest' }],
    ['the query read as typed', { exact: true }],
    ['Creators', { type: 'creators' }],
    ['Recipes', { type: 'recipes' }],
    ['a step of typing', { settled: false }],
  ])('never for %s', (_name, change) => {
    expect(searchBlendApplies({ ...settled, ...change })).toBe(false);
  });

  it('counts words between spaces and sends the parameter only where it applies', () => {
    expect(searchQueryWordCount('')).toBe(0);
    expect(searchQueryWordCount('kling 2.6')).toBe(2);
    expect(searchQueryWordCount(' neon\tcity  rain ')).toBe(3);
    expect(searchBlendParams(true)).toEqual({ [SEARCH_BLEND_PARAM]: '1' });
    expect(searchBlendParams(false)).toEqual({});
    expect(PUBLIC_SEARCH_BLEND_PARAM).toBe(SEARCH_BLEND_PARAM);
  });

  it('reads how a post matched, and an answer without it as a word match', () => {
    expect(readSearchMatchedBy('meaning')).toBe('meaning');
    expect(readSearchMatchedBy('both')).toBe('both');
    expect(readSearchMatchedBy('vector')).toBeNull();
    expect(readSearchMatchedBy(undefined)).toBeNull();
    expect(searchPostMatchedBy({})).toBe('words');
    expect(searchPostMatchedBy({ matchedBy: 'both' })).toBe('both');
    expect(isSearchMeaningOnlyMatch({ matchedBy: 'meaning' })).toBe(true);
    expect(isSearchMeaningOnlyMatch({ matchedBy: 'both' })).toBe(false);
    expect(isSearchMeaningOnlyMatch({})).toBe(false);
  });
});

describe('the blended Posts order: its cursor', () => {
  const id = POST(1);
  const asOf = SEARCH_BEGAN.getTime();

  it('carries the place in the window beside the floor, and reads both back', () => {
    const cursor = { version: 1 as const, type: 'posts' as const, score: 13.18, id, asOf, window: 20 };
    expect(decodePublicSearchCursor(encodePublicSearchCursor(cursor), 'posts', 'top')).toEqual(cursor);
    const filtered = { ...cursor, filters: publicSearchCursorFilterMark({ madeWith: null, mediaKind: 'video', hasRecipe: false, following: false }, false) };
    expect(decodePublicSearchCursor(encodePublicSearchCursor(filtered), 'posts', 'top')).toEqual(filtered);
  });

  it('may have no floor: the first row of the word order is still to come, or no post holds the words', () => {
    const cursor = { version: 1 as const, type: 'posts' as const, asOf, window: 8 };
    expect(decodePublicSearchCursor(encodePublicSearchCursor(cursor), 'posts', 'top')).toEqual(cursor);
  });

  it('carries the post shown last beside the place, with or without a floor', () => {
    const last = POST(4);
    for (const cursor of [
      { version: 1 as const, type: 'posts' as const, score: 13.18, id, asOf, window: 20, last },
      { version: 1 as const, type: 'posts' as const, asOf, window: 8, last },
    ]) {
      expect(decodePublicSearchCursor(encodePublicSearchCursor(cursor), 'posts', 'top')).toEqual(cursor);
    }
    // Never without a place: a cursor past the window is an ordinary Top cursor.
    const plain = encodePublicSearchCursor({ version: 1, type: 'posts', score: 1, id, asOf, last });
    expect(JSON.parse(Buffer.from(plain, 'base64url').toString('utf8'))).not.toHaveProperty('l');
  });

  it('is an ordinary Top cursor to code that knows no place: the floor is where the word order continues', () => {
    const encoded = encodePublicSearchCursor({ version: 1, type: 'posts', score: 13.18, id, asOf, window: 20 });
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    expect(parsed).toEqual({ v: 1, t: 'posts', s: 13.18, i: id, a: asOf, w: 20 });
  });

  const encode = (fields: Record<string, unknown>) => Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
  it.each([
    ['a place of zero', { v: 1, t: 'posts', s: 1, i: id, a: asOf, w: 0 }],
    ['a place past the window', { v: 1, t: 'posts', s: 1, i: id, a: asOf, w: PUBLIC_SEARCH_BLEND_MAX_PLACE + 1 }],
    ['a place that is no integer', { v: 1, t: 'posts', s: 1, i: id, a: asOf, w: 2.5 }],
    ['a place with no instant', { v: 1, t: 'posts', s: 1, i: id, w: 5 }],
    ['half a floor: an id and no score', { v: 1, t: 'posts', i: id, a: asOf, w: 5 }],
    ['half a floor: a score and no id', { v: 1, t: 'posts', s: 1, a: asOf, w: 5 }],
    ['a place on a creators cursor', { v: 1, t: 'creators', s: 1, i: id, w: 5 }],
    ['a last post that is no id', { v: 1, t: 'posts', s: 1, i: id, a: asOf, w: 5, l: 'post-4' }],
    ['a last post with no place', { v: 1, t: 'posts', s: 1, i: id, a: asOf, l: id }],
  ])('refuses %s', (_name, fields) => {
    const type = fields.t === 'creators' ? 'creators' : 'posts';
    expect(decodePublicSearchCursor(encode(fields), type, 'top')).toBeNull();
  });

  it('refuses a place on a Latest cursor', () => {
    expect(decodePublicSearchCursor(
      encode({ v: 1, t: 'posts', r: 'latest', i: id, c: '2026-08-12T00:00:00.123456+00:00', a: asOf, w: 5 }),
      'posts',
      'latest',
    )).toBeNull();
  });

  it('takes the furthest place and no further', () => {
    const cursor = { version: 1 as const, type: 'posts' as const, score: 1, id, asOf, window: PUBLIC_SEARCH_BLEND_MAX_PLACE };
    expect(decodePublicSearchCursor(encodePublicSearchCursor(cursor), 'posts', 'top')).toEqual(cursor);
  });
});

describe('the blended Posts order: the service', () => {
  it('reads the blended list for a search that asked, and says how each post matched', async () => {
    const { search, loadBlendedPostRows, wordCalls } = harness({
      blended: [
        row(1, { matched_by: 'both' }),
        row(2, { matched_by: 'meaning', search_score: null, floor_score: 19, floor_post_id: POST(1) }),
        row(3, { matched_by: 'words', floor_score: 17, floor_post_id: POST(3) }),
      ],
    });
    const result = await search();

    expect(loadBlendedPostRows).toHaveBeenCalledTimes(1);
    expect(loadBlendedPostRows.mock.calls[0][1]).toEqual({
      query: 'ocean at dusk',
      viewerUserId: 'viewer-1',
      viewerKey: 'viewer-1',
      guestNetworkKey: null,
      asOf: SEARCH_BEGAN,
      after: null,
      // The page and one row more.
      limit: 3,
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    });
    // The word order is not read as well.
    expect(wordCalls()).toEqual([]);
    expect(result.posts.items).toEqual([
      { id: POST(1), matchedBy: 'both' },
      { id: POST(2), matchedBy: 'meaning' },
    ]);
    // The cursor: the floor of the last post shown (the furthest word row so
    // far, not the meaning-only post itself) and its place in the window.
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts', 'top')).toEqual({
      version: 1, type: 'posts', score: 19, id: POST(1), asOf: SEARCH_BEGAN.getTime(), window: 2, last: POST(2),
    });
    // And the answer says its posts are in the blended order.
    expect(result.blended).toBe(true);
  });

  it('hands a later page its cursor, and continues the window from its place', async () => {
    const { search, loadBlendedPostRows } = harness({
      blended: [row(3), row(4), row(5, { in_window: false })],
    });
    const cursor = { version: 1 as const, type: 'posts' as const, score: 19, id: POST(1), asOf: SEARCH_BEGAN.getTime() - 5_000, window: 2 };
    const result = await search({ cursor });

    expect(loadBlendedPostRows.mock.calls[0][1]).toMatchObject({ after: cursor, asOf: new Date(cursor.asOf) });
    // The row after the page is past the window: the cursor is an ordinary Top one, at the floor.
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts', 'top')).toEqual({
      version: 1, type: 'posts', score: 16, id: POST(4), asOf: cursor.asOf,
    });
  });

  it('issues a cursor with no floor while only meaning-only posts have been shown', async () => {
    const meaningOnly = (n: number) => row(n, { matched_by: 'meaning', search_score: null, floor_score: null, floor_post_id: null });
    const { search } = harness({ blended: [meaningOnly(1), meaningOnly(2), meaningOnly(3)] });
    const result = await search();
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts', 'top')).toEqual({
      version: 1, type: 'posts', asOf: SEARCH_BEGAN.getTime(), window: 2, last: POST(2),
    });
  });

  it('reads the word order when the blend cannot be read, and still says how each post matched', async () => {
    const { search, wordCalls } = harness({
      blended: null,
      wordRows: [
        { post_id: POST(1), creator_user_id: 'creator-1', search_score: 8, created_at: '2026-11-10T06:00:00+00:00' },
        { post_id: POST(2), creator_user_id: 'creator-2', search_score: 7, created_at: '2026-11-10T06:00:00+00:00' },
        { post_id: POST(3), creator_user_id: 'creator-3', search_score: 6, created_at: '2026-11-10T06:00:00+00:00' },
      ],
    });
    const result = await search();
    expect(wordCalls()).toHaveLength(1);
    // Asked for and not blended: the answer says so.
    expect(result.blended).toBe(false);
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'words' }, { id: POST(2), matchedBy: 'words' }]);
    expect(decodePublicSearchCursor(result.posts.nextCursor, 'posts', 'top')).toEqual({
      version: 1, type: 'posts', score: 7, id: POST(2), asOf: SEARCH_BEGAN.getTime(),
    });
  });

  it('continues a blended list in the word order from the cursor\'s floor when a later page cannot be blended', async () => {
    const { search, wordCalls } = harness({
      blended: null,
      wordRows: [{ post_id: POST(7), creator_user_id: 'creator-7', search_score: 3, created_at: '2026-11-10T06:00:00+00:00' }],
    });
    const result = await search({
      cursor: { version: 1, type: 'posts', score: 19, id: POST(1), asOf: SEARCH_BEGAN.getTime(), window: 2 },
    });
    expect(wordCalls()).toEqual([expect.objectContaining({ p_after_score: 19, p_after_id: POST(1), p_sort: 'top' })]);
    expect(result.posts.items).toEqual([{ id: POST(7), matchedBy: 'words' }]);
    expect(result.posts.nextCursor).toBeNull();
  });

  it('reads the word order from its top when a later page cannot be blended and the cursor has no floor', async () => {
    // The pages so far showed posts from further down the word order (or none
    // that hold the words): nothing of its top has been shown, so nothing may
    // be passed over. A post shown twice is the client's to leave out.
    const { search, wordCalls } = harness({
      blended: null,
      wordRows: [{ post_id: POST(7), creator_user_id: 'creator-7', search_score: 3, created_at: '2026-11-10T06:00:00+00:00' }],
    });
    const result = await search({ cursor: { version: 1, type: 'posts', asOf: SEARCH_BEGAN.getTime(), window: 8, last: POST(3) } });
    expect(wordCalls()).toEqual([expect.objectContaining({
      p_after_score: null, p_after_id: null, p_sort: 'top', p_as_of: SEARCH_BEGAN.toISOString(),
    })]);
    expect(result.posts.items).toEqual([{ id: POST(7), matchedBy: 'words' }]);
    expect(result.posts.nextCursor).toBeNull();
  });

  it('never starts blending in the middle of a list: a cursor with no place pages the word order', async () => {
    const { search, loadBlendedPostRows, wordCalls } = harness({ blended: [row(1)], wordRows: [] });
    await search({ cursor: { version: 1, type: 'posts', score: 19, id: POST(1), asOf: SEARCH_BEGAN.getTime() } });
    expect(loadBlendedPostRows).not.toHaveBeenCalled();
    expect(wordCalls()).toHaveLength(1);
  });

  it.each([
    ['one word', { query: 'ocean', normalizedQuery: 'ocean' }],
    ['a handle', { query: '@ocean dusk', normalizedQuery: 'ocean dusk' }],
    ['Latest', { sort: 'latest' as const }],
    ['the query read as typed', { exact: true }],
    ['a request counted against nobody', { viewerKey: '  ' }],
    ['Recipes', { type: 'recipes' as const }],
  ])('does not blend %s, though the request asked', async (_name, options) => {
    const { search, loadBlendedPostRows } = harness({ blended: [row(1)] });
    await search(options);
    expect(loadBlendedPostRows).not.toHaveBeenCalled();
  });

  it('does not blend, and says nothing new of a post, for a request that did not ask', async () => {
    const { search, loadBlendedPostRows } = harness({
      blended: [row(1)],
      wordRows: [{ post_id: POST(1), creator_user_id: 'creator-1', search_score: 8, created_at: '2026-11-10T06:00:00+00:00' }],
    });
    const result = await search({ blend: false });
    expect(loadBlendedPostRows).not.toHaveBeenCalled();
    expect(result.posts.items).toEqual([{ id: POST(1) }]);
    expect(result).not.toHaveProperty('blended');
  });

  it('blends the Top tab\'s posts too, with no cursor', async () => {
    const { search, loadBlendedPostRows } = harness({ blended: [row(1, { matched_by: 'both' }), row(2)] });
    const result = await search({ type: 'top' });
    expect(loadBlendedPostRows.mock.calls[0][1]).toMatchObject({ after: null, limit: 12 });
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'both' }, { id: POST(2), matchedBy: 'words' }]);
    expect(result.posts.nextCursor).toBeNull();
  });

  it('blends inside the filters of a Posts search', async () => {
    const { search, loadBlendedPostRows } = harness({ blended: [row(1)] });
    const filters = { madeWith: 'model:kling-2.6', mediaKind: 'video' as const, hasRecipe: true, following: true };
    const result = await search({ filters, limit: 1 });
    expect(loadBlendedPostRows.mock.calls[0][1]).toMatchObject({ filters });
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'words' }]);
  });

  it('looks for no related posts beside a blended answer, which holds them already: the group is there and empty', async () => {
    const { search, findRelatedPostRows } = harness({ blended: [row(1, { matched_by: 'meaning', search_score: null })] });
    const result = await search({ related: true, limit: 20 });
    expect(findRelatedPostRows).not.toHaveBeenCalled();
    expect(result.related).toEqual({ posts: [] });
  });

  it('still looks for related posts beside an answer the blend left in the word order', async () => {
    const { search, findRelatedPostRows } = harness({
      blended: [row(1, { blend_state: 'no_vector', in_window: false })],
    });
    const result = await search({ related: true, limit: 20 });
    expect(findRelatedPostRows).toHaveBeenCalledTimes(1);
    expect(result.related).toEqual({ posts: [] });
    expect(result.blended).toBe(false);
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'words' }]);
  });

  it('says a corrected reading as before: such an answer is the word order', async () => {
    const { search } = harness({
      blended: [row(1, { blend_state: 'corrected', corrected_query: 'ocean at dusk', in_window: false })],
    });
    const result = await search({ query: 'ocen at dusk', normalizedQuery: 'ocen at dusk', limit: 20 });
    expect(result.correctedQuery.posts).toBe('ocean at dusk');
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'words' }]);
  });
});

describe('the blended Posts order and related posts: one query vector per search', () => {
  const VECTOR = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
  const ENV = { NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests' };

  function slowFunctionHarness() {
    const calls: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      switch (name) {
        case 'search_public_creators':
        case 'search_public_entities':
        case 'search_related_posts':
          return { data: [], error: null };
        case 'search_recipes_corrected_query':
        case 'search_query_embedding':
        case 'store_search_query_embedding':
          return { data: null, error: null };
        case 'reserve_search_query_embedding':
          return { data: true, error: null };
        case 'search_blended_posts':
          // Nothing cached: the word order, two posts, a thin answer.
          return {
            data: args.p_query_embedding === null
              ? [row(1, { blend_state: 'no_vector', in_window: false }), row(2, { blend_state: 'no_vector', in_window: false })]
              : [row(1, { matched_by: 'both' }), row(2)],
            error: null,
          };
        default:
          throw new Error(`Unexpected RPC ${name}`);
      }
    });
    let answer: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      () => new Promise<Response>((resolve) => { answer = resolve; }),
    );
    const enforceBackendRateLimit = vi.fn<(client: unknown, limit: { scope: string; key: string }) => Promise<{
      allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number; resetAt: string;
    }>>(async () => ({ allowed: true, limit: 40, remaining: 39, retryAfterSeconds: 0, resetAt: '2026-11-16T00:00:00.000Z' }));
    const tasks: Array<() => Promise<unknown>> = [];
    const logEvent = vi.fn();
    const search = () => searchPublicContent({
      query: 'ocean at dusk', normalizedQuery: 'ocean at dusk', type: 'posts', cursor: null, limit: 20,
      viewerUserId: 'viewer-1', viewerKey: 'viewer-1', countryCode: null, blend: true, related: true,
    }, {
      createServiceClient: vi.fn(() => ({ rpc }) as unknown as SupabaseClient),
      getMarketplaceResourceList: vi.fn(async () => ({
        items: [], pageInfo: { hasMore: false, nextOffset: null, offset: 0, limit: 6 },
      })) as never,
      getShowcaseFeedItemsByPostIds: vi.fn(async ({ postIds }: { postIds: string[] }) => postIds.map((id) => ({ id }))) as never,
      loadBlockedCreatorIds: vi.fn(async () => new Set()) as never,
      logEvent,
      now: () => SEARCH_BEGAN,
      runAfterResponse: (task) => { tasks.push(task); },
      // The real lookups, both of them, over a function that does not answer in time.
      queryVector: { env: ENV, fetchImpl: fetchImpl as never, enforceBackendRateLimit: enforceBackendRateLimit as never, queryEmbeddingTimeoutMs: 15 },
    });
    const count = (name: string) => calls.filter((called) => called === name).length;
    return {
      search, count, fetchImpl, enforceBackendRateLimit, logEvent, tasks,
      answerFunction: () => answer(new Response(JSON.stringify({ mode: 'query', model: 'gte-small', dimensions: 384, embedding: VECTOR }))),
    };
  }

  it('takes one unit of the allowance, one place of the day and makes one request, though both stopped waiting', async () => {
    const run = slowFunctionHarness();
    const result = await run.search();

    // The blend stopped waiting and answered in the word order; the answer is
    // thin, so related posts asked too, and joined the request on its way.
    expect(result.blended).toBe(false);
    expect(result.posts.items).toEqual([{ id: POST(1), matchedBy: 'words' }, { id: POST(2), matchedBy: 'words' }]);
    expect(result).not.toHaveProperty('related');
    expect(run.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(run.count('reserve_search_query_embedding')).toBe(1);
    expect(run.fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.count('search_query_embedding')).toBe(1);
    // Each says why it went without, by its own name.
    expect(run.logEvent.mock.calls.map(([, event, fields]) => [event, (fields as { reason?: string }).reason])).toEqual([
      ['public_search_blend_skipped', 'embedding_timeout'],
      ['public_search_related_skipped', 'embedding_timeout'],
    ]);

    // The vector arrives behind the answer and is kept, once, for the next search.
    const kept = Promise.all(run.tasks.splice(0).map((task) => task()));
    run.answerFunction();
    await kept;
    expect(run.count('store_search_query_embedding')).toBe(1);
    expect(run.count('release_search_query_embedding')).toBe(0);
    expect(run.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('the blended Posts order: the search log', () => {
  const answer = (posts: Array<{ id: string; matchedBy?: 'words' | 'meaning' | 'both' }>, more: Partial<PublicSearchResponse> = {}) => ({
    query: 'ocean at dusk', normalizedQuery: 'ocean at dusk', type: 'posts' as const, sort: 'top' as const, entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: { items: [], nextCursor: null }, posts: { items: posts, nextCursor: null }, recipes: { items: [], nextCursor: null },
    ...more,
  }) as unknown as PublicSearchResponse;
  const row = (response: PublicSearchResponse) => buildSearchQueryEventRow({
    normalizedQuery: 'ocean at dusk', type: 'posts', sort: 'top', viewerKey: 'network-key', signedIn: false,
    requestedAt: SEARCH_BEGAN, response,
  }, 'a'.repeat(64));

  it('counts a blended answer\'s word matches as its posts and its meaning-only posts apart, and says it was blended', () => {
    expect(row(answer([
      { id: 'a', matchedBy: 'both' }, { id: 'b', matchedBy: 'meaning' }, { id: 'c', matchedBy: 'words' }, { id: 'd', matchedBy: 'meaning' },
    ], { blended: true }))).toMatchObject({ post_count: 2, related_count: 2, blended: true });
  });

  it('logs a blended answer the words found nothing for as a zero-result search, as the word order logs it', () => {
    // "ocean at dusk": no post holds the words, three mean it.
    const blendedRow = row(answer([
      { id: 'a', matchedBy: 'meaning' }, { id: 'b', matchedBy: 'meaning' }, { id: 'c', matchedBy: 'meaning' },
    ], { blended: true }));
    const wordRow = row(answer([], { related: { posts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never } }));
    expect(blendedRow).toMatchObject({ post_count: 0, related_count: 3, blended: true });
    expect(wordRow).toMatchObject({ post_count: 0, related_count: 3 });
    expect(wordRow).not.toHaveProperty('blended');
  });

  it('counts a thin blended answer with nothing found by meaning as 0, never as "not looked for"', () => {
    expect(row(answer([{ id: 'a', matchedBy: 'words' }], { blended: true, related: { posts: [] } })))
      .toMatchObject({ post_count: 1, related_count: 0, blended: true });
    expect(row(answer([{ id: 'a', matchedBy: 'words' }], { blended: true })))
      .toMatchObject({ post_count: 1, related_count: 0, blended: true });
  });

  it('writes the row of an answer in the word order as it always was: no flag, every post counted', () => {
    // Asked for the blend and answered in the word order.
    const fellBack = row(answer([{ id: 'a', matchedBy: 'words' }, { id: 'b', matchedBy: 'words' }], { blended: false }));
    expect(fellBack).toMatchObject({ post_count: 2, related_count: null });
    expect(fellBack).not.toHaveProperty('blended');
    // Not asked.
    const plain = row(answer([{ id: 'a' }, { id: 'b' }]));
    expect(plain).toMatchObject({ post_count: 2, related_count: null });
    expect(Object.keys(plain ?? {})).not.toContain('blended');
  });
});

describe('the blended Posts order: the route', () => {
  function emptyResponse(query: string, type: PublicSearchResponse['type']): PublicSearchResponse {
    return {
      query, normalizedQuery: query, type, sort: 'top', entities: [],
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
      correctedQuery: { posts: null, recipes: null }, exact: false,
      creators: { items: [], nextCursor: null }, posts: { items: [], nextCursor: null }, recipes: { items: [], nextCursor: null },
    };
  }
  async function ask(search: string) {
    const service = vi.fn(async (options: PublicSearchOptions) => emptyResponse(options.query, options.type));
    const response = await getPublicSearchRouteResponse({
      request: new Request(`http://localhost/api/search?${search}`),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true, limit: 180, remaining: 179, retryAfterSeconds: 0, resetAt: '2026-11-15T12:00:00.000Z',
        })),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent: service,
        runAfterResponse: () => {},
        withProviderFetchRequestId: <T>(_id: string, callback: () => T): T => callback(),
      },
    });
    return { response, options: service.mock.calls[0]?.[0] ?? null };
  }

  it('asks the service to blend only when the request says blend=1', async () => {
    expect((await ask('q=ocean+at+dusk&type=posts')).options).not.toHaveProperty('blend');
    expect((await ask('q=ocean+at+dusk&type=posts&blend=1')).options).toMatchObject({ blend: true, viewerKey: 'network-key' });
  });

  it('takes the parameter on any search: it changes nothing where the blend does not apply', async () => {
    for (const search of ['q=ocean&blend=1', 'q=ocean+at+dusk&type=creators&blend=1', 'q=ocean+at+dusk&type=posts&sort=latest&blend=1']) {
      const { response, options } = await ask(search);
      expect(response.status, search).toBe(200);
      expect(options, search).toMatchObject({ blend: true });
    }
  });

  it.each(['0', 'true', 'yes', ''])('refuses blend=%s', async (value) => {
    const { response, options } = await ask(`q=ocean+at+dusk&blend=${value}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'blend must be 1.' });
    expect(options).toBeNull();
  });

  it('pages a blended list by the cursor it issued', async () => {
    const cursor = { version: 1 as const, type: 'posts' as const, score: 13.18, id: POST(1), asOf: SEARCH_BEGAN.getTime(), window: 20 };
    const { response, options } = await ask(`q=ocean+at+dusk&type=posts&blend=1&cursor=${encodePublicSearchCursor(cursor)}`);
    expect(response.status).toBe(200);
    expect(options).toMatchObject({ blend: true, cursor });
  });
});

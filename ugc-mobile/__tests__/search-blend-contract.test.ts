import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { createApiClient } from '../lib/api-client';
import {
  SEARCH_BLEND_MIN_WORDS,
  SEARCH_BLEND_PARAM,
  SEARCH_MATCH_SOURCES,
  isSearchAnswerBlended,
  isSearchMeaningOnlyMatch,
  readSearchMatchedBy,
  searchBlendApplies,
  searchBlendParams,
  searchPostMatchedBy,
  searchQueryWordCount,
  withoutShownSearchPosts,
} from '../lib/public-search-policy/search-blend';

// The blended Posts order as the app is held to it
// (contracts/mobile-api-v1.json, searchPublicContent). The server's half is
// src/__tests__/search-blend-contract.test.ts. Both search screens send the
// parameter (the app's through searchRequestExtras): this pins the rules they
// read, and that the answer reaches them whole.

const search = mobileApiContract.endpoints.searchPublicContent;

function clientAnswering(body: unknown) {
  const asked: URL[] = [];
  const api = createApiClient({
    baseUrl: 'https://magicbooklet.test',
    getAccessToken: async () => 'token-1',
    fetcher: vi.fn(async (input: RequestInfo | URL) => {
      asked.push(new URL(String(input)));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { api, asked };
}

describe('the blended Posts order in the mobile API contract', () => {
  it('names the parameter and the ways a post can match as the contract does', () => {
    expect(SEARCH_BLEND_PARAM).toBe(search.blendParameter);
    expect([...SEARCH_MATCH_SOURCES]).toEqual(search.matchSources);
    expect(searchBlendParams(true)).toEqual({ [search.blendParameter]: '1' });
    expect(searchBlendParams(false)).toEqual({});
  });

  it('reads the pinned request as one that is blended, and its neighbours as ones that are not', () => {
    const { query } = search.responseVariants.blendedPosts;
    expect(query[search.blendParameter as 'blend']).toBe('1');
    const settled = { query: query.q, type: query.type, sort: 'top', exact: false, settled: true };
    expect(searchBlendApplies(settled)).toBe(true);
    expect(searchBlendApplies({ ...settled, type: 'top' })).toBe(true);
    expect(SEARCH_BLEND_MIN_WORDS).toBe(2);
    expect(searchQueryWordCount(query.q)).toBe(3);
    for (const change of [
      { query: 'ocean' }, { query: '@ocean dusk' }, { sort: 'latest' }, { exact: true },
      { type: 'creators' }, { type: 'recipes' }, { settled: false },
    ]) {
      expect(searchBlendApplies({ ...settled, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it('reads how each post of the pinned answer matched', () => {
    const posts = search.responseVariants.blendedPosts.response.posts.items;
    expect(posts.map((post) => readSearchMatchedBy(post.matchedBy))).toEqual(['both', 'meaning']);
    expect(posts.map((post) => isSearchMeaningOnlyMatch(post))).toEqual([false, true]);
  });

  it('reads a post of an answer without the field as a word match: a server from before the blend, or a request that did not ask', () => {
    // Every post the contract pins outside the blended answer: the search's own and the related ones.
    const posts: Array<[string, Record<string, unknown>]> = [];
    for (const [name, answer] of [
      ['response', search.response] as const,
      ...Object.entries(search.responseVariants).filter(([variant]) => variant !== 'blendedPosts').map(([variant, pinned]) => [variant, pinned.response] as const),
    ]) {
      const held = answer as { blended?: unknown; posts: { items: Array<Record<string, unknown>> }; related?: { posts: Array<Record<string, unknown>> } };
      for (const post of [...held.posts.items, ...(held.related?.posts ?? [])]) posts.push([name, post]);
      expect(isSearchAnswerBlended(held), name).toBe(false);
    }
    // The fixture holds such posts: this is not a loop over nothing.
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const [name, post] of posts) {
      expect(post, name).not.toHaveProperty('matchedBy');
      expect(searchPostMatchedBy(post), name).toBe('words');
      expect(isSearchMeaningOnlyMatch(post), name).toBe(false);
    }
    expect(readSearchMatchedBy('vector')).toBeNull();
    expect(searchPostMatchedBy({ matchedBy: 'vector' })).toBe('words');
  });

  it('reads the pinned blended answer as blended', () => {
    expect(search.responseVariants.blendedPosts.response.blended).toBe(true);
    expect(isSearchAnswerBlended(search.responseVariants.blendedPosts.response)).toBe(true);
    expect(isSearchAnswerBlended({ blended: false })).toBe(false);
    expect(isSearchAnswerBlended({ blended: 'true' })).toBe(false);
  });

  it('leaves out, by id, the posts of a later page that are already on show', () => {
    expect(search.laterPages).toMatchObject({ mayRepeatPosts: true, deduplicateBy: 'id' });
    const [first, second] = search.responseVariants.blendedPosts.response.posts.items;
    const third = { ...second, id: 'post-12' };
    // A page that repeats a post shown, and holds one post twice.
    expect(withoutShownSearchPosts([first, second], [second, third, first, third])).toEqual([third]);
    expect(withoutShownSearchPosts([], [first, second])).toEqual([first, second]);
    // A page of nothing but repeats is an empty page, not the end of the list.
    expect(withoutShownSearchPosts([first, second], [second, first])).toEqual([]);
  });

  it('hands a blended answer to the screen whole, its cursor included', async () => {
    const { blendedPosts } = search.responseVariants;
    const { api } = clientAnswering(blendedPosts.response);
    const page = await api.searchPublicContent({ query: blendedPosts.query.q, type: 'posts', sort: 'top' });
    expect(page).toEqual(blendedPosts.response);
    expect(page.posts.nextCursor).toBe(search.cursors.blendedTopPosts.encoded);
    // The cursor is the server's to read: the app sends it back as it came.
    const next = clientAnswering(blendedPosts.response);
    await next.api.searchPublicContent({ query: blendedPosts.query.q, type: 'posts', sort: 'top', cursor: page.posts.nextCursor });
    expect(next.asked[0].searchParams.get('cursor')).toBe(search.cursors.blendedTopPosts.encoded);
  });

  it('pins the refusal of another value', () => {
    expect(search.errors.unknownBlend).toEqual({
      query: { q: 'Neon product', blend: 'yes' }, status: 400, response: { error: 'blend must be 1.' },
    });
  });
});

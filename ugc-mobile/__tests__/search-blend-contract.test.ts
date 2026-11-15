import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { createApiClient } from '../lib/api-client';
import {
  SEARCH_BLEND_MIN_WORDS,
  SEARCH_BLEND_PARAM,
  SEARCH_MATCH_SOURCES,
  isSearchMeaningOnlyMatch,
  readSearchMatchedBy,
  searchBlendApplies,
  searchBlendParams,
  searchPostMatchedBy,
  searchQueryWordCount,
} from '../lib/public-search-policy/search-blend';

// The blended Posts order as the app is held to it
// (contracts/mobile-api-v1.json, searchPublicContent). The server's half is
// src/__tests__/search-blend-contract.test.ts. No screen sends the parameter
// yet: this pins the rules a screen will read, and that the answer reaches it
// whole.

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
    for (const [name, variant] of Object.entries(search.responseVariants)) {
      if (name === 'blendedPosts') continue;
      for (const post of variant.response.posts.items as Array<Record<string, unknown>>) {
        expect(post, name).not.toHaveProperty('matchedBy');
        expect(searchPostMatchedBy(post), name).toBe('words');
      }
    }
    expect(readSearchMatchedBy('vector')).toBeNull();
    expect(searchPostMatchedBy({ matchedBy: 'vector' })).toBe('words');
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

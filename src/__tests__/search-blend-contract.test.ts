import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

import {
  PUBLIC_SEARCH_BLEND_PARAM,
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  type PublicSearchCursor,
  type PublicSearchResponse,
} from '@/lib/public-search';
import { getPublicSearchRouteResponse } from '@/lib/public-search-route-adapter-service';
import type { PublicSearchOptions } from '@/lib/public-search-service';

import {
  SEARCH_MATCH_SOURCES,
  isSearchAnswerBlended,
  readSearchMatchedBy,
  searchBlendApplies,
  withoutShownSearchPosts,
} from '../../ugc-mobile/lib/public-search-policy/search-blend';

// The blended Posts order as the web and the app are both held to it
// (contracts/mobile-api-v1.json, searchPublicContent): the parameter, how a
// post says it matched, the cursor of a blended list and the refusal. The
// app's half is ugc-mobile/__tests__/search-blend-contract.test.ts.

const endpoint = mobileApiContract.endpoints.searchPublicContent;

async function ask(query: Record<string, string>, answer?: PublicSearchResponse) {
  const service = vi.fn(async (options: PublicSearchOptions) => answer ?? ({
    query: options.query, normalizedQuery: options.normalizedQuery, type: options.type, sort: 'top', entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: { items: [], nextCursor: null }, posts: { items: [], nextCursor: null }, recipes: { items: [], nextCursor: null },
  } satisfies PublicSearchResponse));
  const response = await getPublicSearchRouteResponse({
    request: new Request(`http://localhost${endpoint.path}?${new URLSearchParams(query)}`),
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

describe('the blended Posts order in the mobile API contract', () => {
  it('pins the parameter and the ways a post can match', () => {
    expect(endpoint.blendParameter).toBe('blend');
    expect(PUBLIC_SEARCH_BLEND_PARAM).toBe(endpoint.blendParameter);
    expect(endpoint.matchSources).toEqual([...SEARCH_MATCH_SOURCES]);
  });

  it('pins a blended answer: the request that asks, and each post saying how it matched', async () => {
    const { blendedPosts } = endpoint.responseVariants;
    expect(blendedPosts.query).toEqual({ q: 'ocean at dusk', type: 'posts', [endpoint.blendParameter]: '1' });
    expect(searchBlendApplies({
      query: blendedPosts.query.q, type: blendedPosts.query.type, sort: 'top', exact: false, settled: true,
    })).toBe(true);

    const { response, options } = await ask(blendedPosts.query, blendedPosts.response as unknown as PublicSearchResponse);
    expect(response.status).toBe(200);
    expect(options).toMatchObject({ blend: true, type: 'posts', sort: 'top', cursor: null });
    await expect(response.json()).resolves.toEqual(blendedPosts.response);

    const posts = blendedPosts.response.posts.items;
    expect(posts.map((post) => readSearchMatchedBy(post.matchedBy))).toEqual(['both', 'meaning']);
    // And the answer says its posts are in the blended order.
    expect(blendedPosts.response.blended).toBe(true);
    expect(isSearchAnswerBlended(blendedPosts.response)).toBe(true);
    // A post result is a feed card and one field more.
    const card = endpoint.responseVariants.relatedPosts.response.related.posts[0];
    for (const post of posts) {
      expect(Object.keys(post).filter((key) => key !== 'matchedBy').sort()).toEqual(Object.keys(card).sort());
    }
    // Its next page is asked for by the blended cursor.
    expect(blendedPosts.response.posts.nextCursor).toBe(endpoint.cursors.blendedTopPosts.encoded);
  });

  it('pins the cursor of a blended list: the floor, the instant and the place', async () => {
    for (const name of ['blendedTopPosts', 'blendedTopPostsWithoutFloor'] as const) {
      const cursor = endpoint.cursors[name];
      expect(encodePublicSearchCursor(cursor.decoded as PublicSearchCursor), name).toBe(cursor.encoded);
      expect(decodePublicSearchCursor(cursor.encoded, 'posts', 'top'), name).toEqual(cursor.decoded);
    }
    // The place, the post shown last, and the floor where there is one.
    expect(endpoint.cursors.blendedTopPosts.decoded).toMatchObject({
      window: 20, score: 13.18, last: '22222222-2222-4222-8222-222222222222',
    });
    expect(endpoint.cursors.blendedTopPostsWithoutFloor.decoded).not.toHaveProperty('id');
    expect(endpoint.cursors.blendedTopPostsWithoutFloor.decoded).toHaveProperty('last');

    const { blendedPosts } = endpoint.responseVariants;
    const { response, options } = await ask({ ...blendedPosts.query, cursor: endpoint.cursors.blendedTopPosts.encoded });
    expect(response.status).toBe(200);
    expect(options).toMatchObject({ blend: true, cursor: endpoint.cursors.blendedTopPosts.decoded });
    // Read by a request that does not ask for the blend, it is a Top cursor at the floor.
    const plain = await ask({ q: blendedPosts.query.q, type: 'posts', cursor: endpoint.cursors.blendedTopPosts.encoded });
    expect(plain.response.status).toBe(200);
    expect(plain.options).not.toHaveProperty('blend');
  });

  it('refuses an unknown value with the words the fixture pins', async () => {
    const refusal = endpoint.errors.unknownBlend;
    const { response, options } = await ask(refusal.query);
    expect(response.status).toBe(refusal.status);
    await expect(response.json()).resolves.toEqual(refusal.response);
    expect(options).toBeNull();
  });

  it('pins what a later page may hold: a post already shown, which a client leaves out by its id', () => {
    expect(endpoint.laterPages.mayRepeatPosts).toBe(true);
    expect(endpoint.laterPages.deduplicateBy).toBe('id');
    expect(endpoint.laterPages.rule).toMatch(/MUST leave out, by id/);
    const [first, second] = endpoint.responseVariants.blendedPosts.response.posts.items;
    expect(withoutShownSearchPosts([first], [first, second, second])).toEqual([second]);
  });

  it('pins no matchedBy on any other answer: a request that did not ask is answered as before', () => {
    const answers: Array<[string, { posts: { items: unknown[] }; related?: { posts: unknown[] } }]> = [
      ['response', endpoint.response],
      ...Object.entries(endpoint.responseVariants)
        .filter(([name]) => name !== 'blendedPosts')
        .map(([name, variant]) => [name, variant.response] as [string, { posts: { items: unknown[] }; related?: { posts: unknown[] } }]),
    ];
    for (const [name, answer] of answers) {
      for (const post of [...answer.posts.items, ...(answer.related?.posts ?? [])]) {
        expect(post, name).not.toHaveProperty('matchedBy');
      }
      expect(answer, name).not.toHaveProperty('blended');
    }
    // The fixture holds such posts: this is not a loop over nothing.
    expect(answers.flatMap(([, answer]) => [...answer.posts.items, ...(answer.related?.posts ?? [])]).length).toBeGreaterThanOrEqual(3);
    // The same search without the parameter: the same cards, in the word order, and nothing more said.
    const { wordOrderPosts, blendedPosts } = endpoint.responseVariants;
    expect(wordOrderPosts.query).toEqual({ q: blendedPosts.query.q, type: 'posts' });
    expect(wordOrderPosts.response.posts.items).toEqual(
      blendedPosts.response.posts.items.map((post) => Object.fromEntries(Object.entries(post).filter(([key]) => key !== 'matchedBy'))),
    );
    expect(wordOrderPosts.response.posts.nextCursor).toBe(endpoint.cursors.topPosts.encoded);
  });
});

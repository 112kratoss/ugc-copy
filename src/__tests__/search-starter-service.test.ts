import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { getPostModelDisplayName } from '@/lib/post-model-labels';
import {
  SEARCH_STARTER_CREATOR_LIMIT,
  SEARCH_STARTER_ENTITY_LIMIT,
  SEARCH_STARTER_SEARCH_LIMIT,
  SEARCH_STARTER_SUGGESTED_SEARCHES,
} from '@/lib/search-starter';
import { normalizeCreatorSearchQuery } from '@/lib/public-search';
import { getSearchStarter } from '@/lib/search-starter-service';

import { searchStarterEntityAction } from '../../ugc-mobile/lib/public-search-policy/search-starter';

const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

function creatorRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    username: `luna-${index}`,
    display_name: `Luna ${index}`,
    bio: null,
    avatar_url: null,
    public_post_count: index,
    is_following: false,
    ...overrides,
  };
}

function entityRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'tool', key: `tool-${index}`, label: `Tool ${index}`, post_count: 10 - index, post_count_capped: false,
    query: `tool ${index}`, ...overrides,
  };
}

function clientAnswering(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<typeof answer>>(async () => answer);
  // The public bucket's address of a stored path, as supabase-js builds it: no request is made.
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.example.test/showcase_media/${path}` } }));
  const from = vi.fn(() => ({ getPublicUrl }));
  return { rpc, from, createServiceClient: () => ({ rpc, storage: { from } }) as unknown as SupabaseClient };
}

const ALL_TIME = { entities: 'all', creators: 'all', searches: 'all' };

describe('search starter service', () => {
  it('makes one database call with the viewer, the hand-picked searches and the three caps, and answers its lists in order', async () => {
    const { rpc, createServiceClient } = clientAnswering({
      data: {
        entities: [
          entityRow(1, { label: 'Lumen Forge', key: 'lumen-forge', post_count: 1000, post_count_capped: true, query: 'lumen forge' }),
          entityRow(2),
        ],
        creators: [
          creatorRow(1, { bio: 'Portraits', avatar_url: 'https://cdn.example.test/a.png' }),
          creatorRow(2),
        ],
        searches: [{ text: 'portrait' }, { text: 'nano banana' }],
      },
      error: null,
    });

    await expect(getSearchStarter({ viewerUserId: VIEWER_ID }, { createServiceClient })).resolves.toEqual({
      entities: [
        { kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', postCount: 1000, postCountCapped: true, thumbnail: null, query: 'lumen forge' },
        { kind: 'tool', key: 'tool-2', label: 'Tool 2', postCount: 8, postCountCapped: false, thumbnail: null, query: 'tool 2' },
      ],
      creators: [
        {
          id: '11111111-1111-4111-8111-000000000001',
          username: 'luna-1',
          displayName: 'Luna 1',
          bio: 'Portraits',
          avatarUrl: 'https://cdn.example.test/a.png',
          publicPostCount: 1,
          isFollowing: false,
        },
        {
          id: '11111111-1111-4111-8111-000000000002',
          username: 'luna-2',
          displayName: 'Luna 2',
          bio: null,
          avatarUrl: null,
          publicPostCount: 2,
          isFollowing: false,
        },
      ],
      searches: [{ text: 'portrait', thumbnail: null }, { text: 'nano banana', thumbnail: null }],
      // A database from before 20261115105944 answers no periods: every list is the all-time one.
      periods: ALL_TIME,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_starter', {
      p_viewer_user_id: VIEWER_ID,
      p_terms: [...SEARCH_STARTER_SUGGESTED_SEARCHES],
      p_entity_limit: SEARCH_STARTER_ENTITY_LIMIT,
      p_creator_limit: SEARCH_STARTER_CREATOR_LIMIT,
      p_search_limit: SEARCH_STARTER_SEARCH_LIMIT,
    });
  });

  it('asks for a visitor with no viewer', async () => {
    const { rpc, createServiceClient } = clientAnswering({ data: { entities: [], creators: [], searches: [] }, error: null });
    await expect(getSearchStarter({ viewerUserId: null }, { createServiceClient }))
      .resolves.toEqual({ entities: [], creators: [], searches: [], periods: ALL_TIME });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_viewer_user_id: null });
  });

  it('sends the searches trimmed, without empty ones, and at most twenty', async () => {
    const { rpc, createServiceClient } = clientAnswering({ data: { entities: [], creators: [], searches: [] }, error: null });
    const many = Array.from({ length: 25 }, (_, index) => `term ${index}`);
    await getSearchStarter({ viewerUserId: null }, { createServiceClient, suggestedSearches: ['  anime ', '', '   ', ...many] });
    const sent = rpc.mock.calls[0][1].p_terms as string[];
    expect(sent).toHaveLength(20);
    expect(sent.slice(0, 2)).toEqual(['anime', 'term 0']);
  });

  describe('this week’s lists and their pictures (20261115105944)', () => {
    const picture = {
      post_id: '44444444-4444-4444-8444-444444444444',
      path: 'owner/post/preview.webp',
      thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
      width: 832,
      height: 1248,
      media_kind: 'image',
    };
    const drawn = {
      postId: '44444444-4444-4444-8444-444444444444',
      url: 'https://cdn.example.test/showcase_media/owner/post/preview.webp',
      thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
      width: 832,
      height: 1248,
      mediaKind: 'image',
    };

    it('says which period each list is of, as the database answered it', async () => {
      const { createServiceClient } = clientAnswering({
        data: { entities: [], creators: [], searches: [], periods: { entities: 'week', creators: 'all', searches: 'week' } },
        error: null,
      });
      await expect(getSearchStarter({ viewerUserId: null }, { createServiceClient }))
        .resolves.toMatchObject({ periods: { entities: 'week', creators: 'all', searches: 'week' } });
    });

    it.each([
      ['no periods', undefined],
      ['periods that are not an object', 'week'],
      ['a period it does not know', { entities: 'month', creators: 7, searches: null }],
    ])('reads %s as all-time: a heading says "this week" only when that is true', async (_name, periods) => {
      const { createServiceClient } = clientAnswering({ data: { entities: [], creators: [], searches: [], periods }, error: null });
      await expect(getSearchStarter({ viewerUserId: null }, { createServiceClient })).resolves.toMatchObject({ periods: ALL_TIME });
    });

    it('gives a model, a tool and a search its picture, by the stored preview’s public address, in the one database call', async () => {
      const { rpc, createServiceClient } = clientAnswering({
        data: {
          entities: [entityRow(1, { thumbnail: picture }), entityRow(2, { thumbnail: null })],
          creators: [],
          searches: [{ text: 'cinematic portrait', thumbnail: picture }, { text: 'neon city', thumbnail: null }, { text: 'anime' }],
        },
        error: null,
      });
      const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
      expect(answer.entities.map((entity) => entity.thumbnail)).toEqual([drawn, null]);
      expect(answer.searches).toEqual([
        { text: 'cinematic portrait', thumbnail: drawn },
        { text: 'neon city', thumbnail: null },
        { text: 'anime', thumbnail: null },
      ]);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('never draws an address of the private bucket, where a labelled post’s media lives', async () => {
      const { from, createServiceClient } = clientAnswering({
        data: {
          entities: [entityRow(1, { thumbnail: { ...picture, path: 'private-posts/owner/post/preview.webp' } })],
          creators: [],
          searches: [{ text: 'anime', thumbnail: { ...picture, path: 'private-posts/owner/post/preview.webp' } }],
        },
        error: null,
      });
      const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
      expect(answer.entities[0].thumbnail).toBeNull();
      expect(answer.searches[0].thumbnail).toBeNull();
      expect(from).not.toHaveBeenCalled();
    });

    it('leaves out a search the route would search as other words than the database held', async () => {
      const { createServiceClient } = clientAnswering({
        data: { entities: [], creators: [], searches: [{ text: 'ｎeon city' }, { text: 'Product Photo' }, { text: 'neon city' }] },
        error: null,
      });
      const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
      expect(answer.searches.map((search) => search.text)).toEqual(['Product Photo', 'neon city']);
    });
  });

  it('names a model made here as search names it, so a row and the search it opens read the same', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        entities: [{ kind: 'model', key: 'nano-banana-pro', label: 'nano-banana-pro', post_count: 12, post_count_capped: false, query: 'nano banana pro' }],
        creators: [],
        searches: [],
      },
      error: null,
    });
    const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
    expect(answer.entities[0].label).toBe(getPostModelDisplayName('nano-banana-pro'));
    expect(answer.entities[0].label).not.toBe('nano-banana-pro');
  });

  it('keeps the query the database counted apart from the name drawn: a catalog name can hold words the posts do not', async () => {
    // PR #785's review: qwen3 is "Qwen Image 3.0" in the catalog, and a post made
    // with it holds qwen3, never "image" or "3.0". A row that searched its
    // name would open none of the posts it counted; the database sends the
    // name its posts print, lowercased.
    const { createServiceClient } = clientAnswering({
      data: {
        entities: [{ kind: 'model', key: 'qwen3', label: 'qwen3', post_count: 2, post_count_capped: false, query: 'qwen3' }],
        creators: [],
        searches: [],
      },
      error: null,
    });
    const [entity] = (await getSearchStarter({ viewerUserId: null }, { createServiceClient })).entities;
    expect(entity.label).toBe(getPostModelDisplayName('qwen3'));
    expect(entity.label).not.toBe('qwen3');
    expect(entity.query).toBe('qwen3');
    expect(searchStarterEntityAction(entity)).toMatchObject({ query: 'qwen3', madeWith: 'model:qwen3' });
  });

  it.each([
    ['full-width letters', 'ｍidjourney ｖ７', 'midjourney v7'],
    ['a superscript', 'kling²', 'kling2'],
    ['a leading @', '@studio tool', 'studio tool'],
    ['a no-break space', 'lumen\u00a0forge', 'lumen forge'],
  ])('leaves out an entity whose query holds %s, which /api/search would search as other words', async (_name, query, searched) => {
    // What the route sends the database for q (public-search-route-adapter-service):
    // a different text than the one the count was made for.
    expect(normalizeCreatorSearchQuery(query).toLowerCase()).toBe(searched);
    const { createServiceClient } = clientAnswering({
      data: {
        entities: [entityRow(1, { query }), entityRow(2, { query: 'tool 2' })],
        creators: [],
        searches: [],
      },
      error: null,
    });
    const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
    expect(answer.entities.map((entity) => entity.query)).toEqual(['tool 2']);
  });

  it('keeps an entity whose query the route searches as it is', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        entities: [entityRow(1, { query: 'kling 2.6' }), entityRow(2, { query: 'nano-banana-pro' }), entityRow(3, { query: 'café crème' })],
        creators: [],
        searches: [],
      },
      error: null,
    });
    const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
    expect(answer.entities.map((entity) => entity.query)).toEqual(['kling 2.6', 'nano-banana-pro', 'café crème']);
  });

  it('never answers more than its caps, whatever the database returns', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        entities: Array.from({ length: 12 }, (_, index) => entityRow(index)),
        creators: Array.from({ length: 12 }, (_, index) => creatorRow(index + 1)),
        searches: Array.from({ length: 12 }, (_, index) => ({ text: `term ${index}` })),
      },
      error: null,
    });
    const answer = await getSearchStarter({ viewerUserId: null }, { createServiceClient });
    expect(answer.entities).toHaveLength(SEARCH_STARTER_ENTITY_LIMIT);
    expect(answer.creators).toHaveLength(SEARCH_STARTER_CREATOR_LIMIT);
    expect(answer.searches).toHaveLength(SEARCH_STARTER_SEARCH_LIMIT);
  });

  it('throws the database’s error', async () => {
    const failure = new Error('function public.search_starter does not exist');
    const { createServiceClient } = clientAnswering({ data: null, error: failure });
    await expect(getSearchStarter({ viewerUserId: null }, { createServiceClient })).rejects.toBe(failure);
  });

  it.each([
    ['no answer', null],
    ['a list', []],
    ['an answer without searches', { entities: [], creators: [] }],
    ['a list that is not one', { entities: {}, creators: [], searches: [] }],
    ['a creator without a handle', { entities: [], creators: [creatorRow(1, { username: '' })], searches: [] }],
    ['a creator without a post count', { entities: [], creators: [creatorRow(1, { public_post_count: null })], searches: [] }],
    ['a creator without a bio field', { entities: [], creators: [{ ...creatorRow(1), bio: undefined }], searches: [] }],
    ['an entity of another kind', { entities: [entityRow(1, { kind: 'creator' })], creators: [], searches: [] }],
    ['an entity without its count flag', { entities: [entityRow(1, { post_count_capped: null })], creators: [], searches: [] }],
    ['an entity without the query it is counted for', { entities: [entityRow(1, { query: undefined })], creators: [], searches: [] }],
    ['an entity with an empty query', { entities: [entityRow(1, { query: '  ' })], creators: [], searches: [] }],
    ['an empty search', { entities: [], creators: [], searches: [{ text: '' }] }],
  ])('throws on %s: a migration and this file out of step, never drawn as something', async (_name, data) => {
    const { createServiceClient } = clientAnswering({ data, error: null });
    await expect(getSearchStarter({ viewerUserId: null }, { createServiceClient }))
      .rejects.toThrow('search_starter returned an unexpected answer.');
  });
});

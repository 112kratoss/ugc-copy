import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { getPostModelDisplayName } from '@/lib/post-feed-presentation';
import {
  SEARCH_SUGGEST_MAX_COMPLETIONS,
  SEARCH_SUGGEST_MAX_CREATORS,
  SEARCH_SUGGEST_MAX_ENTITIES,
} from '@/lib/search-suggest';
import { suggestSearch, type SearchSuggestOptions } from '@/lib/search-suggest-service';

const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

function creatorRow(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    username: `luna-${index}`,
    display_name: `Luna ${index}`,
    avatar_url: null,
    is_following: false,
    ...overrides,
  };
}

function clientAnswering(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => answer);
  // The public bucket's address of a stored path, as supabase-js builds it: no request is made.
  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.example.test/showcase_media/${path}` } }));
  const from = vi.fn(() => ({ getPublicUrl }));
  return { rpc, from, getPublicUrl, createServiceClient: () => ({ rpc, storage: { from } }) as unknown as SupabaseClient };
}

const options: SearchSuggestOptions = {
  query: ' Lu',
  normalizedQuery: 'Lu',
  handlesOnly: false,
  viewerUserId: VIEWER_ID,
};

describe('search suggest service', () => {
  it('makes one database call, with the viewer and both caps, and answers its lists in order', async () => {
    const { rpc, createServiceClient } = clientAnswering({
      data: {
        creators: [
          creatorRow(1, { avatar_url: 'https://cdn.example.test/a.png', is_following: true }),
          creatorRow(2),
        ],
        entities: [{ kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', post_count: 14, post_count_capped: false }],
        completions: [{ text: 'luminous' }, { text: 'lunar' }],
      },
      error: null,
    });

    await expect(suggestSearch(options, { createServiceClient })).resolves.toEqual({
      query: ' Lu',
      normalizedQuery: 'Lu',
      creators: [
        {
          id: '11111111-1111-4111-8111-000000000001',
          username: 'luna-1',
          displayName: 'Luna 1',
          avatarUrl: 'https://cdn.example.test/a.png',
          isFollowing: true,
        },
        {
          id: '11111111-1111-4111-8111-000000000002',
          username: 'luna-2',
          displayName: 'Luna 2',
          avatarUrl: null,
          isFollowing: false,
        },
      ],
      entities: [{ kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', postCount: 14, postCountCapped: false, thumbnail: null, inCatalog: false, catalogModel: null, query: null }],
      completions: [{ text: 'luminous' }, { text: 'lunar' }],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_suggestions', {
      p_query: 'Lu',
      p_viewer_user_id: VIEWER_ID,
      p_handles_only: false,
      p_creator_limit: SEARCH_SUGGEST_MAX_CREATORS,
      p_completion_limit: SEARCH_SUGGEST_MAX_COMPLETIONS,
      // Not asked for: no row a client from before the catalog cannot open.
      p_catalog: false,
    });
  });

  it('asks for a visitor with no viewer, and for handles alone when the query was typed as one', async () => {
    const { rpc, createServiceClient } = clientAnswering({ data: { creators: [], completions: [] }, error: null });
    await suggestSearch({ ...options, viewerUserId: null, handlesOnly: true }, { createServiceClient });
    expect(rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({
      p_viewer_user_id: null,
      p_handles_only: true,
    }));
  });

  it('sends the query as it was read, whatever it holds: nothing here builds a pattern from it', async () => {
    for (const odd of ['%', '_', '\\', '\'; drop table posts; --', 'a & b | !c', 'quil:*', '🔥', 'a'.repeat(100)]) {
      const { rpc, createServiceClient } = clientAnswering({ data: { creators: [], completions: [] }, error: null });
      await expect(suggestSearch({ ...options, query: odd, normalizedQuery: odd }, { createServiceClient }))
        .resolves.toMatchObject({ creators: [], entities: [], completions: [] });
      expect(rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({ p_query: odd }));
    }
  });

  it('names a model as full search names it, and a tool as its posts print it', async () => {
    // A model made here is known to the database by its key; the catalog gives its name.
    const catalogModel = 'nano-banana-pro';
    expect(getPostModelDisplayName(catalogModel)).toBeTruthy();
    const { createServiceClient } = clientAnswering({
      data: {
        creators: [],
        entities: [
          { kind: 'model', key: catalogModel, label: catalogModel, post_count: 1000, post_count_capped: true },
          { kind: 'model', key: 'some-outside-model', label: 'Some Outside Model', post_count: 2, post_count_capped: false },
          // A tool that happens to share a catalog model's key keeps its own name.
          { kind: 'tool', key: catalogModel, label: 'A tool of that name', post_count: 3, post_count_capped: false },
        ],
        completions: [],
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(answer.entities).toEqual([
      { kind: 'model', key: catalogModel, label: getPostModelDisplayName(catalogModel), postCount: 1000, postCountCapped: true, thumbnail: null, inCatalog: false, catalogModel: null, query: null },
      { kind: 'model', key: 'some-outside-model', label: 'Some Outside Model', postCount: 2, postCountCapped: false, thumbnail: null, inCatalog: false, catalogModel: null, query: null },
      { kind: 'tool', key: catalogModel, label: 'A tool of that name', postCount: 3, postCountCapped: false, thumbnail: null, inCatalog: false, catalogModel: null, query: null },
    ]);
    // By the one function full search maps an entity with.
    expect(readFileSync(join(process.cwd(), 'src/lib/search-suggest-service.ts'), 'utf8'))
      .toContain("import { entityResult } from '@/lib/public-search-service';");
  });

  it('names a motion creation’s model by the catalog, not by the provider’s id it is stored under', async () => {
    // Live on 2026-11-12: "kling" offered an entity that read "kling-2.6/motion-control".
    const { createServiceClient } = clientAnswering({
      data: {
        creators: [],
        entities: [{ kind: 'model', key: 'kling-2.6-motion-control', label: 'kling-2.6/motion-control', post_count: 31, post_count_capped: false }],
        completions: [],
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(answer.entities).toEqual([
      { kind: 'model', key: 'kling-2.6-motion-control', label: 'Kling 2.6', postCount: 31, postCountCapped: false, thumbnail: null, inCatalog: false, catalogModel: null, query: null },
    ]);
  });

  describe('an entity’s picture (20261115105944)', () => {
    const entity = { kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', post_count: 14, post_count_capped: false };
    const picture = {
      post_id: '44444444-4444-4444-8444-444444444444',
      path: 'owner/post/preview.webp',
      thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
      width: 1024,
      height: 1536,
      media_kind: 'video',
    };
    const answerWith = async (thumbnail: unknown) => {
      const fake = clientAnswering({
        data: { creators: [], entities: [{ ...entity, ...(thumbnail === undefined ? {} : { thumbnail }) }], completions: [] },
        error: null,
      });
      const answer = await suggestSearch(options, { createServiceClient: fake.createServiceClient });
      return { ...fake, thumbnail: answer.entities[0].thumbnail };
    };

    it('is the stored preview’s public address and the cover’s thumbhash, size and kind, with no read of storage', async () => {
      const { thumbnail, rpc, from, getPublicUrl } = await answerWith(picture);
      expect(thumbnail).toEqual({
        postId: '44444444-4444-4444-8444-444444444444',
        url: 'https://cdn.example.test/showcase_media/owner/post/preview.webp',
        thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI',
        width: 1024,
        height: 1536,
        mediaKind: 'video',
      });
      // The typeahead stays one database round trip: the address is built, not fetched.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('showcase_media');
      expect(getPublicUrl).toHaveBeenCalledWith('owner/post/preview.webp');
    });

    it('is null when the database answers none, and from a database before pictures', async () => {
      expect((await answerWith(null)).thumbnail).toBeNull();
      expect((await answerWith(undefined)).thumbnail).toBeNull();
    });

    it('is never an address of the private bucket, where a labelled post’s media lives', async () => {
      const { thumbnail, from } = await answerWith({ ...picture, path: 'private-posts/owner/post/preview.webp' });
      expect(thumbnail).toBeNull();
      expect(from).not.toHaveBeenCalled();
    });

    it.each([
      ['no path', { ...picture, path: null }],
      ['an empty path', { ...picture, path: '' }],
      ['no post', { ...picture, post_id: null }],
      ['a list', [picture]],
      ['a string', 'owner/post/preview.webp'],
    ])('is null for a row it cannot read (%s): the entity is still offered', async (_name, row) => {
      expect((await answerWith(row)).thumbnail).toBeNull();
    });

    it('reads a missing thumbhash or size as null, and any kind but video as an image', async () => {
      const { thumbnail } = await answerWith({ post_id: picture.post_id, path: picture.path, width: 0, height: 'tall', media_kind: 'gif' });
      expect(thumbnail).toEqual({
        postId: picture.post_id,
        url: 'https://cdn.example.test/showcase_media/owner/post/preview.webp',
        thumbhash: null,
        width: null,
        height: null,
        mediaKind: 'image',
      });
    });
  });

  describe('a model of the product’s own catalog (20261115105944)', () => {
    const catalogRow = (overrides: Record<string, unknown> = {}) => ({
      kind: 'model', key: 'zephyr-2', label: 'Zephyr 2', post_count: 1, post_count_capped: false, thumbnail: null,
      in_catalog: true, catalog_model: { id: 'zephyr-2', kind: 'video', web: true, mobile: false }, query: null,
      ...overrides,
    });
    const entitiesOf = async (rows: unknown[], catalog?: boolean) => {
      const fake = clientAnswering({ data: { creators: [], entities: rows, completions: [] }, error: null });
      const answer = await suggestSearch({ ...options, ...(catalog === undefined ? {} : { catalog }) }, { createServiceClient: fake.createServiceClient });
      return { ...fake, entities: answer.entities };
    };

    it('asks the database for every catalog model only when the request did', async () => {
      expect((await entitiesOf([], true)).rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({ p_catalog: true }));
      expect((await entitiesOf([], false)).rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({ p_catalog: false }));
      expect((await entitiesOf([])).rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({ p_catalog: false }));
    });

    it('says a row is a catalog model, which one, and the search that opens its posts', async () => {
      const { entities } = await entitiesOf([
        catalogRow(),
        catalogRow({ key: 'zephyr-lite', label: 'Zephyr Lite', post_count: 0, catalog_model: { id: 'zephyr-lite', kind: 'image', web: true, mobile: true } }),
        catalogRow({ key: 'zephyr-pro', label: 'Zephyr Pro', post_count: 4, catalog_model: { id: 'zephyr-pro', kind: 'motion', web: false, mobile: true }, query: ' zephyr-pro ' }),
      ], true);
      expect(entities).toEqual([
        {
          kind: 'model', key: 'zephyr-2', label: 'Zephyr 2', postCount: 1, postCountCapped: false, thumbnail: null,
          inCatalog: true, catalogModel: { id: 'zephyr-2', kind: 'video', web: true, mobile: false }, query: null,
        },
        {
          kind: 'model', key: 'zephyr-lite', label: 'Zephyr Lite', postCount: 0, postCountCapped: false, thumbnail: null,
          inCatalog: true, catalogModel: { id: 'zephyr-lite', kind: 'image', web: true, mobile: true }, query: null,
        },
        {
          kind: 'model', key: 'zephyr-pro', label: 'Zephyr Pro', postCount: 4, postCountCapped: false, thumbnail: null,
          inCatalog: true, catalogModel: { id: 'zephyr-pro', kind: 'motion', web: false, mobile: true }, query: 'zephyr-pro',
        },
      ]);
    });

    it('names a catalog model the code catalog knows by that catalog, and any other by the name the database sent', async () => {
      const { entities } = await entitiesOf([
        catalogRow({ key: 'nano-banana-pro', label: 'A name the database holds', catalog_model: { id: 'nano-banana-pro', kind: 'image', web: true, mobile: true } }),
        catalogRow(),
      ]);
      expect(entities.map((entity) => entity.label)).toEqual([getPostModelDisplayName('nano-banana-pro'), 'Zephyr 2']);
    });

    it.each([
      ['no flag', { in_catalog: undefined }],
      ['a flag that is not true', { in_catalog: 'yes' }],
      ['no model', { catalog_model: null }],
      ['a model with no id', { catalog_model: { id: '', kind: 'video', web: true, mobile: true } }],
      ['a model of a kind with no creator', { catalog_model: { id: 'zephyr-2', kind: 'audio', web: true, mobile: true } }],
    ])('does not say a row is a catalog model on %s: a client opens a creator by it', async (_name, overrides) => {
      const { entities } = await entitiesOf([catalogRow(overrides)]);
      expect(entities[0]).toMatchObject({ inCatalog: false, catalogModel: null });
    });

    it('reads a database from before the catalog: no row is a catalog model, and none carries a query', async () => {
      const { entities } = await entitiesOf([{ kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', post_count: 2, post_count_capped: false }]);
      expect(entities[0]).toMatchObject({ inCatalog: false, catalogModel: null, query: null, thumbnail: null });
    });

    it('leaves out a catalog model with no posts when a row of the same name holds its posts', async () => {
      // A motion creation is stored under the provider's id, which the database
      // keys apart from the catalog's: both rows read "Kling 2.6".
      const { entities } = await entitiesOf([
        catalogRow({ key: 'kling-2.6', label: 'Kling 2.6', post_count: 0, catalog_model: { id: 'kling-2.6', kind: 'motion', web: true, mobile: true } }),
        { kind: 'model', key: 'kling-2.6-motion-control', label: 'kling-2.6/motion-control', post_count: 31, post_count_capped: false, in_catalog: false, catalog_model: null, query: null },
        catalogRow({ key: 'zephyr-lite', label: 'Zephyr Lite', post_count: 0, catalog_model: { id: 'zephyr-lite', kind: 'image', web: true, mobile: true } }),
      ], true);
      expect(entities.map((entity) => [entity.key, entity.label, entity.postCount])).toEqual([
        ['kling-2.6-motion-control', 'Kling 2.6', 31],
        ['zephyr-lite', 'Zephyr Lite', 0],
      ]);
    });

    it('keeps a tool and a model of one name apart, and two models with posts under one name', async () => {
      const { entities } = await entitiesOf([
        catalogRow({ key: 'zephyr', label: 'Zephyr', post_count: 0, catalog_model: { id: 'zephyr', kind: 'image', web: true, mobile: true } }),
        { kind: 'tool', key: 'zephyr', label: 'Zephyr', post_count: 5, post_count_capped: false },
      ], true);
      expect(entities.map((entity) => entity.kind)).toEqual(['model', 'tool']);
    });
  });

  it('offers no entities from a database that answers none, as before 20261112192423', async () => {
    const { createServiceClient } = clientAnswering({
      data: { creators: [creatorRow(1)], completions: [{ text: 'lunar' }] },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(answer.entities).toEqual([]);
    expect(answer.creators).toHaveLength(1);
    expect(answer.completions).toEqual([{ text: 'lunar' }]);
  });

  it('never answers more than its caps, whatever the database returns', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        creators: Array.from({ length: 30 }, (_, index) => creatorRow(index + 1)),
        entities: Array.from({ length: 30 }, (_, index) => ({
          kind: 'tool', key: `tool-${index}`, label: `Tool ${index}`, post_count: 30 - index, post_count_capped: false,
        })),
        completions: Array.from({ length: 30 }, (_, index) => ({ text: `word${index}` })),
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(answer.creators).toHaveLength(SEARCH_SUGGEST_MAX_CREATORS);
    expect(answer.entities).toHaveLength(SEARCH_SUGGEST_MAX_ENTITIES);
    expect(answer.entities.map((entity) => entity.key)).toEqual(['tool-0', 'tool-1', 'tool-2']);
    expect(answer.completions).toHaveLength(SEARCH_SUGGEST_MAX_COMPLETIONS);
    // The database's order is kept: the cut is from the end.
    expect(answer.creators.map((creator) => creator.username)).toEqual(['luna-1', 'luna-2', 'luna-3', 'luna-4', 'luna-5']);
    expect(answer.completions[0]).toEqual({ text: 'word0' });
  });

  it('answers only the fields a row draws, never another column the database might return', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        creators: [creatorRow(1, { email: 'private@example.invalid', bio: 'a bio', search_score: 31.2 })],
        completions: [{ text: 'lunar', post_count: 12, creator_count: 3 }],
        entities: [{ kind: 'tool', key: 'lumen-forge', label: 'Lumen Forge', post_count: 2, post_count_capped: false, creator_count: 2 }],
        queries: [{ text: 'from the log' }],
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(Object.keys(answer).sort()).toEqual(['completions', 'creators', 'entities', 'normalizedQuery', 'query']);
    expect(Object.keys(answer.entities[0]).sort()).toEqual(['catalogModel', 'inCatalog', 'key', 'kind', 'label', 'postCount', 'postCountCapped', 'query', 'thumbnail']);
    expect(Object.keys(answer.creators[0]).sort()).toEqual(['avatarUrl', 'displayName', 'id', 'isFollowing', 'username']);
    expect(answer.completions).toEqual([{ text: 'lunar' }]);
  });

  it('fails on a database error', async () => {
    const failure = { message: 'function public.search_suggestions does not exist', code: 'PGRST202' };
    const { createServiceClient } = clientAnswering({ data: null, error: failure });
    await expect(suggestSearch(options, { createServiceClient })).rejects.toBe(failure);
  });

  it.each([
    ['nothing', null],
    ['a list', []],
    ['a string', 'ok'],
    ['no creators', { completions: [] }],
    ['no completions', { creators: [] }],
    ['creators that are not a list', { creators: {}, completions: [] }],
    ['a creator with no handle', { creators: [creatorRow(1, { username: '' })], completions: [] }],
    ['a creator with no id', { creators: [creatorRow(1, { id: null })], completions: [] }],
    ['a creator with no name', { creators: [creatorRow(1, { display_name: undefined })], completions: [] }],
    ['a follow that is not a boolean', { creators: [creatorRow(1, { is_following: 'true' })], completions: [] }],
    ['an avatar that is not text', { creators: [creatorRow(1, { avatar_url: 7 })], completions: [] }],
    ['a creator that is not a row', { creators: ['luna'], completions: [] }],
    ['entities that are not a list', { creators: [], entities: {}, completions: [] }],
    ['an entity of another kind', { creators: [], entities: [{ kind: 'creator', key: 'a', label: 'A', post_count: 1, post_count_capped: false }], completions: [] }],
    ['an entity with no key', { creators: [], entities: [{ kind: 'tool', key: '', label: 'A', post_count: 1, post_count_capped: false }], completions: [] }],
    ['an entity with no count', { creators: [], entities: [{ kind: 'tool', key: 'a', label: 'A', post_count_capped: false }], completions: [] }],
    ['an entity whose cap is not a boolean', { creators: [], entities: [{ kind: 'tool', key: 'a', label: 'A', post_count: 1 }], completions: [] }],
    ['a completion that is bare text', { creators: [], completions: ['lunar'] }],
    ['a completion with no text', { creators: [], completions: [{ text: '' }] }],
  ])('fails, rather than answer an empty or half-drawn list, on %s', async (_name, data) => {
    const { createServiceClient } = clientAnswering({ data, error: null });
    await expect(suggestSearch(options, { createServiceClient }))
      .rejects.toThrow('search_suggestions returned an unexpected answer.');
  });
});

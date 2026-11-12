import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { SEARCH_SUGGEST_MAX_COMPLETIONS, SEARCH_SUGGEST_MAX_CREATORS } from '@/lib/search-suggest';
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
  return { rpc, createServiceClient: () => ({ rpc }) as unknown as SupabaseClient };
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
      completions: [{ text: 'luminous' }, { text: 'lunar' }],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_suggestions', {
      p_query: 'Lu',
      p_viewer_user_id: VIEWER_ID,
      p_handles_only: false,
      p_creator_limit: SEARCH_SUGGEST_MAX_CREATORS,
      p_completion_limit: SEARCH_SUGGEST_MAX_COMPLETIONS,
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
        .resolves.toMatchObject({ creators: [], completions: [] });
      expect(rpc).toHaveBeenCalledWith('search_suggestions', expect.objectContaining({ p_query: odd }));
    }
  });

  it('never answers more than its caps, whatever the database returns', async () => {
    const { createServiceClient } = clientAnswering({
      data: {
        creators: Array.from({ length: 30 }, (_, index) => creatorRow(index + 1)),
        completions: Array.from({ length: 30 }, (_, index) => ({ text: `word${index}` })),
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(answer.creators).toHaveLength(SEARCH_SUGGEST_MAX_CREATORS);
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
        entities: [{ kind: 'model', id: 'veo-3.1' }],
      },
      error: null,
    });
    const answer = await suggestSearch(options, { createServiceClient });
    expect(Object.keys(answer).sort()).toEqual(['completions', 'creators', 'normalizedQuery', 'query']);
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
    ['a completion that is bare text', { creators: [], completions: ['lunar'] }],
    ['a completion with no text', { creators: [], completions: [{ text: '' }] }],
  ])('fails, rather than answer an empty or half-drawn list, on %s', async (_name, data) => {
    const { createServiceClient } = clientAnswering({ data, error: null });
    await expect(suggestSearch(options, { createServiceClient }))
      .rejects.toThrow('search_suggestions returned an unexpected answer.');
  });
});

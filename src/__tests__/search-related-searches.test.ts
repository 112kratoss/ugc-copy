import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { findRelatedSearches, isSearchRelatedSearchesDisabled } from '@/lib/search-related-searches';

import {
  SEARCH_RELATED_SEARCHES_MAX,
  SEARCH_RELATED_SEARCHES_PARAM,
  searchRelatedSearches,
  searchRelatedSearchesApply,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

vi.mock('server-only', () => ({}));

const POSTS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

function clientAnswering(answer: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => answer);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const options = { query: 'portrait', correctedQuery: null, postIds: POSTS, viewerUserId: 'viewer-1' };

describe('findRelatedSearches', () => {
  it('makes one call to search_related_searches with the query, the viewer, the page’s posts and the cap', async () => {
    const { client, rpc } = clientAnswering({
      data: [{ related: 'cinematic portrait' }, { related: 'nano banana pro' }],
      error: null,
    });
    const logEvent = vi.fn();
    await expect(findRelatedSearches(client, options, { logEvent })).resolves.toEqual([
      { text: 'cinematic portrait' },
      { text: 'nano banana pro' },
    ]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('search_related_searches', {
      p_query: 'portrait',
      p_viewer_user_id: 'viewer-1',
      p_post_ids: POSTS,
      p_corrected_query: null,
      p_limit: SEARCH_RELATED_SEARCHES_MAX,
    });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('sends the corrected reading and a visitor’s null viewer as they are', async () => {
    const { client, rpc } = clientAnswering({ data: [], error: null });
    await findRelatedSearches(client, { ...options, correctedQuery: 'portrait', viewerUserId: null }, { logEvent: vi.fn() });
    expect(rpc).toHaveBeenCalledWith('search_related_searches', expect.objectContaining({
      p_corrected_query: 'portrait',
      p_viewer_user_id: null,
    }));
  });

  it('asks nothing for a page with no posts', async () => {
    const { client, rpc } = clientAnswering({ data: [{ related: 'never read' }], error: null });
    await expect(findRelatedSearches(client, { ...options, postIds: [] }, { logEvent: vi.fn() })).resolves.toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never answers more than the cap, and leaves out a row that is not a search', async () => {
    const { client } = clientAnswering({
      data: [
        { related: '  cinematic portrait ' },
        { related: '' },
        { related: null },
        { text: 'wrong key' },
        null,
        'a string',
        ...Array.from({ length: 12 }, (_, index) => ({ related: `phrase ${index}` })),
      ],
      error: null,
    });
    const found = await findRelatedSearches(client, options, { logEvent: vi.fn() });
    expect(found).toHaveLength(SEARCH_RELATED_SEARCHES_MAX);
    expect(found[0]).toEqual({ text: 'cinematic portrait' });
    expect(found[1]).toEqual({ text: 'phrase 0' });
  });

  it('answers none for an answer that is not a list', async () => {
    const { client } = clientAnswering({ data: { related: 'x' }, error: null });
    await expect(findRelatedSearches(client, options, { logEvent: vi.fn() })).resolves.toEqual([]);
  });

  it('answers none and logs a line when the read fails: a search never fails for them', async () => {
    const failure = { message: 'function public.search_related_searches does not exist', code: 'PGRST202' };
    const { client } = clientAnswering({ data: null, error: failure });
    const logEvent = vi.fn();
    await expect(findRelatedSearches(client, options, { logEvent })).resolves.toEqual([]);
    expect(logEvent).toHaveBeenCalledWith('warn', 'public_search_related_searches_failed', { error: failure });

    const thrown = new Error('socket hang up');
    const rpc = vi.fn(async () => { throw thrown; });
    await expect(findRelatedSearches({ rpc } as unknown as SupabaseClient, options, { logEvent })).resolves.toEqual([]);
    expect(logEvent).toHaveBeenLastCalledWith('warn', 'public_search_related_searches_failed', { error: thrown });
  });
});

describe('the related searches’ kill switch', () => {
  it.each(['1', 'true', ' TRUE '])('SEARCH_RELATED_SEARCHES_DISABLED=%j is on', (value) => {
    expect(isSearchRelatedSearchesDisabled({ SEARCH_RELATED_SEARCHES_DISABLED: value })).toBe(true);
  });

  it.each([undefined, '', '0', 'false', 'off'])('SEARCH_RELATED_SEARCHES_DISABLED=%j is off', (value) => {
    expect(isSearchRelatedSearchesDisabled({ SEARCH_RELATED_SEARCHES_DISABLED: value })).toBe(false);
  });

  it('is listed in .env.example, so the E2E server unsets it', () => {
    expect(readFileSync(join(process.cwd(), '.env.example'), 'utf8')).toMatch(/^# SEARCH_RELATED_SEARCHES_DISABLED=1$/m);
  });
});

describe('the clients’ shared rules for related searches', () => {
  it('names the parameter and the cap', () => {
    expect(SEARCH_RELATED_SEARCHES_PARAM).toBe('relatedSearches');
    expect(SEARCH_RELATED_SEARCHES_MAX).toBe(6);
  });

  it('applies on the first page of a Top or Posts search, and nowhere else', () => {
    expect(searchRelatedSearchesApply({ type: 'top', firstPage: true })).toBe(true);
    expect(searchRelatedSearchesApply({ type: 'posts', firstPage: true })).toBe(true);
    expect(searchRelatedSearchesApply({ type: 'posts', firstPage: false })).toBe(false);
    expect(searchRelatedSearchesApply({ type: 'creators', firstPage: true })).toBe(false);
    expect(searchRelatedSearchesApply({ type: 'recipes', firstPage: true })).toBe(false);
  });

  it('reads an answer’s related searches, none for an answer without the field, never a row that is not whole', () => {
    expect(searchRelatedSearches({ relatedSearches: [{ text: 'cinematic portrait' }, { text: ' neon city ' }] }))
      .toEqual([{ text: 'cinematic portrait' }, { text: 'neon city' }]);
    for (const none of [null, undefined, {}, { relatedSearches: null }, { relatedSearches: 'portrait' }, { relatedSearches: {} }]) {
      expect(searchRelatedSearches(none)).toEqual([]);
    }
    expect(searchRelatedSearches({ relatedSearches: [{ text: '' }, { text: 7 }, null, 'portrait', { text: 'anime' }] }))
      .toEqual([{ text: 'anime' }]);
    expect(searchRelatedSearches({
      relatedSearches: Array.from({ length: 12 }, (_, index) => ({ text: `phrase ${index}` })),
    })).toHaveLength(SEARCH_RELATED_SEARCHES_MAX);
  });
});

import { describe, expect, it } from 'vitest';

import { MAX_MARKETPLACE_RESOURCE_OFFSET } from '@/lib/marketplace-resource-list-route-adapter-service';
import {
  PUBLIC_SEARCH_MAX_RECIPE_OFFSET,
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  normalizePublicSearchQuery,
  parsePublicSearchLimit,
  parsePublicSearchType,
  publicSearchQueryLength,
} from '@/lib/public-search';

describe('public search policy', () => {
  it('normalizes unicode, whitespace, and creator handles', () => {
    expect(normalizePublicSearchQuery('  AI\t  UGC  ')).toBe('AI UGC');
    expect(normalizeCreatorSearchQuery('  @@Creator-Name  ')).toBe('Creator-Name');
  });

  it('counts a query in characters, as the database does, not in UTF-16 units', () => {
    // An emoji is one character to Postgres' char_length and two to `.length`.
    expect('\u{1F600}'.length).toBe(2);
    expect(publicSearchQueryLength('\u{1F600}')).toBe(1);
    expect(publicSearchQueryLength('\u{1F600}\u{1F600}')).toBe(2);
    expect(publicSearchQueryLength('veo 3')).toBe(5);
    expect(publicSearchQueryLength('')).toBe(0);
  });

  it('rejects oversized raw queries instead of silently accepting truncation', () => {
    expect(isPublicSearchQueryTooLong('x'.repeat(101))).toBe(true);
    expect(isPublicSearchQueryTooLong('x'.repeat(100))).toBe(false);
  });

  it('parses bounded types and limits', () => {
    expect(parsePublicSearchType('posts')).toBe('posts');
    expect(parsePublicSearchType('unknown')).toBeNull();
    expect(parsePublicSearchLimit(null)).toBe(20);
    expect(parsePublicSearchLimit('24')).toBe(24);
    expect(parsePublicSearchLimit('25')).toBeNull();
    expect(parsePublicSearchLimit('-1')).toBeNull();
  });

  it('round-trips entity-specific opaque cursors', () => {
    const postCursor = encodePublicSearchCursor({
      version: 1,
      type: 'posts',
      score: 4.25,
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(decodePublicSearchCursor(postCursor, 'posts')).toEqual({
      version: 1,
      type: 'posts',
      score: 4.25,
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(decodePublicSearchCursor(postCursor, 'creators')).toBeNull();

    const recipeCursor = encodePublicSearchCursor({ version: 1, type: 'recipes', offset: 24 });
    expect(decodePublicSearchCursor(recipeCursor, 'recipes')).toEqual({
      version: 1,
      type: 'recipes',
      offset: 24,
    });
  });

  // An offset past the list's own cap was a safe integer the RPC's integer
  // parameter overflowed on (a 500), or arbitrarily deep paging.
  it('caps a recipes cursor at the marketplace list\'s deepest offset', () => {
    const recipes = (offset: unknown) => decodePublicSearchCursor(
      Buffer.from(JSON.stringify({ v: 1, t: 'recipes', o: offset }), 'utf8').toString('base64url'),
      'recipes',
    );

    expect(PUBLIC_SEARCH_MAX_RECIPE_OFFSET).toBe(MAX_MARKETPLACE_RESOURCE_OFFSET);
    expect(recipes(0)).toEqual({ version: 1, type: 'recipes', offset: 0 });
    expect(recipes(PUBLIC_SEARCH_MAX_RECIPE_OFFSET)).toEqual({ version: 1, type: 'recipes', offset: 960 });
    expect(recipes(PUBLIC_SEARCH_MAX_RECIPE_OFFSET + 1)).toBeNull();
    expect(recipes(2 ** 31)).toBeNull();
    expect(recipes(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(recipes(-1)).toBeNull();
    expect(recipes(1.5)).toBeNull();
  });

  it('rejects hand-built cursors whose id is not a UUID', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, t: 'posts', s: 4.25, i: 'not-a-uuid' }), 'utf8')
      .toString('base64url');
    expect(decodePublicSearchCursor(forged, 'posts')).toBeNull();
  });
});

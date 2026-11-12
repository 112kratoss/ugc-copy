import { describe, expect, it } from 'vitest';

import { MAX_MARKETPLACE_RESOURCE_OFFSET } from '@/lib/marketplace-resource-list-route-adapter-service';
import {
  PUBLIC_SEARCH_MAX_RECIPE_OFFSET,
  PUBLIC_SEARCH_SORTS,
  PUBLIC_SEARCH_TYPES,
  appliedPublicSearchSort,
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  isPublicSearchQueryTooLong,
  normalizeCreatorSearchQuery,
  normalizePublicSearchQuery,
  parsePublicSearchLimit,
  parsePublicSearchSort,
  parsePublicSearchType,
  publicSearchQueryLength,
  publicSearchTypeHasSorts,
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

  it('counts the maximum in characters, as the minimums and the database count: a hundred emoji are not too long', () => {
    const emoji = '\u{1F600}';
    // Two UTF-16 units each: counted that way, fifty-one were refused.
    for (const count of [51, 99, 100]) {
      expect(emoji.repeat(count).length).toBeGreaterThan(100);
      expect(isPublicSearchQueryTooLong(emoji.repeat(count)), String(count)).toBe(false);
    }
    expect(isPublicSearchQueryTooLong(emoji.repeat(101))).toBe(true);
    // Counted after the query is normalized, as it is searched: spaces collapse first.
    expect(isPublicSearchQueryTooLong(`  ${emoji.repeat(50)}     ${emoji.repeat(49)}  `)).toBe(false);
    expect(isPublicSearchQueryTooLong(null)).toBe(false);
  });

  it('cuts a query at a hundred characters, never through the middle of one', () => {
    const emoji = '\u{1F600}';
    expect(normalizePublicSearchQuery(emoji.repeat(100))).toBe(emoji.repeat(100));
    const cut = normalizePublicSearchQuery(emoji.repeat(120));
    expect(publicSearchQueryLength(cut)).toBe(100);
    expect(cut).toBe(emoji.repeat(100));
    // An odd place: ninety-nine letters, then emoji. The hundredth character is a whole emoji.
    const mixed = normalizePublicSearchQuery(`${'x'.repeat(99)}${emoji.repeat(3)}`);
    expect(mixed).toBe(`${'x'.repeat(99)}${emoji}`);
    expect(normalizePublicSearchQuery('x'.repeat(140))).toBe('x'.repeat(100));
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

  it('names two sorts, top when a request names none, and refuses any other', () => {
    expect(PUBLIC_SEARCH_SORTS).toEqual(['top', 'latest']);
    expect(parsePublicSearchSort(null)).toBe('top');
    expect(parsePublicSearchSort(undefined)).toBe('top');
    expect(parsePublicSearchSort('top')).toBe('top');
    expect(parsePublicSearchSort('latest')).toBe('latest');
    expect(parsePublicSearchSort('')).toBeNull();
    expect(parsePublicSearchSort('Latest')).toBeNull();
    expect(parsePublicSearchSort('recent')).toBeNull();
  });

  it('reads only Posts and Recipes in another order than the ranked one', () => {
    expect(PUBLIC_SEARCH_TYPES.filter(publicSearchTypeHasSorts)).toEqual(['posts', 'recipes']);
    expect(appliedPublicSearchSort('posts', 'latest')).toBe('latest');
    expect(appliedPublicSearchSort('recipes', 'latest')).toBe('latest');
    expect(appliedPublicSearchSort('top', 'latest')).toBe('top');
    expect(appliedPublicSearchSort('creators', 'latest')).toBe('top');
  });

  describe('a posts cursor', () => {
    const ID = '11111111-1111-1111-1111-111111111111';
    const AS_OF = Date.parse('2026-11-12T10:00:00.000Z');
    const forge = (fields: Record<string, unknown>) => (
      Buffer.from(JSON.stringify({ v: 1, t: 'posts', ...fields }), 'utf8').toString('base64url')
    );

    it('carries the instant a Top search is scored at', () => {
      const cursor = encodePublicSearchCursor({ version: 1, type: 'posts', score: 12.5, id: ID, asOf: AS_OF });
      expect(decodePublicSearchCursor(cursor, 'posts')).toEqual({
        version: 1, type: 'posts', score: 12.5, id: ID, asOf: AS_OF,
      });
      expect(decodePublicSearchCursor(cursor, 'posts', 'top')).not.toBeNull();
    });

    it('still decodes one issued before instants existed, as a Top cursor without one', () => {
      // Byte for byte what the app live before 2026-11-12 encodes.
      const legacy = forge({ s: 4.25, i: ID });
      expect(decodePublicSearchCursor(legacy, 'posts')).toEqual({ version: 1, type: 'posts', score: 4.25, id: ID });
      expect(decodePublicSearchCursor(legacy, 'posts', 'latest')).toBeNull();
    });

    it('carries the last row’s created_at for Latest, as the database wrote it', () => {
      const createdAt = '2026-11-12T10:00:00.123456+00:00';
      const cursor = encodePublicSearchCursor({ version: 1, type: 'posts', sort: 'latest', createdAt, id: ID });
      expect(decodePublicSearchCursor(cursor, 'posts', 'latest')).toEqual({
        version: 1, type: 'posts', sort: 'latest', createdAt, id: ID,
      });
      // A cursor pages the order it was issued for.
      expect(decodePublicSearchCursor(cursor, 'posts')).toBeNull();
      expect(decodePublicSearchCursor(cursor, 'posts', 'top')).toBeNull();
    });

    it('refuses an instant or a created_at a timestamptz parameter would not take', () => {
      for (const asOf of [
        0, -1, 1.5, '1762941600000', 253_402_300_800_000, Number.MAX_SAFE_INTEGER, null,
        // Before anything here was made: the year is held as created_at's is.
        1, Date.UTC(2019, 11, 31, 23, 59, 59, 999),
      ]) {
        expect(decodePublicSearchCursor(forge({ s: 4.25, i: ID, a: asOf }), 'posts'), String(asOf)).toBeNull();
      }
      expect(decodePublicSearchCursor(forge({ s: 4.25, i: ID, a: 253_402_300_799_999 }), 'posts')).not.toBeNull();
      expect(decodePublicSearchCursor(forge({ s: 4.25, i: ID, a: Date.UTC(2020, 0, 1) }), 'posts')).not.toBeNull();
      for (const createdAt of [
        '2026-11-12', '2026-11-12 10:00:00+00', 'now()', "2026-11-12T10:00:00Z'; drop table posts; --",
        '2026-13-45T10:00:00Z', 1762941600000, null, undefined,
        // Each of these V8 parses and Postgres refuses as a timestamptz, which was a 500:
        // the year 0000; 30 February, which V8 rolls to 2 March; offsets past any real one.
        '0000-01-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-11-12T10:00:00+16:00', '2026-11-12T10:00:00+23:59',
        '2026-11-12T10:00:00-15:00', '2026-11-12T10:00:00+14:60', '2026-04-31T10:00:00.5+00:00',
        '2026-11-12T24:00:00Z', '2026-11-12T23:59:60Z', '2019-12-31T23:59:59Z', '10000-01-01T00:00:00Z',
      ]) {
        expect(
          decodePublicSearchCursor(forge({ r: 'latest', c: createdAt, i: ID }), 'posts', 'latest'),
          String(createdAt),
        ).toBeNull();
      }
      for (const createdAt of [
        '2026-11-12T10:00:00Z', '2026-11-12T10:00:00.123456+00:00', '2028-02-29T23:59:59.9+05:30',
        '2026-11-12T10:00:00-08:00', '2026-11-12T10:00:00+14:00', '2020-01-01T00:00:00Z', '9999-12-31T23:59:59Z',
      ]) {
        expect(
          decodePublicSearchCursor(forge({ r: 'latest', c: createdAt, i: ID }), 'posts', 'latest')?.createdAt,
          createdAt,
        ).toBe(createdAt);
      }
      // A Latest cursor needs its id, and an unknown sort is no sort.
      expect(decodePublicSearchCursor(forge({ r: 'latest', c: '2026-11-12T10:00:00Z' }), 'posts', 'latest')).toBeNull();
      expect(decodePublicSearchCursor(forge({ r: 'oldest', s: 4.25, i: ID }), 'posts')).toBeNull();
      expect(decodePublicSearchCursor(forge({ r: 7, s: 4.25, i: ID }), 'posts')).toBeNull();
    });
  });

  it('keeps a recipes cursor to the order it was issued for', () => {
    const latest = encodePublicSearchCursor({ version: 1, type: 'recipes', sort: 'latest', offset: 24 });
    expect(decodePublicSearchCursor(latest, 'recipes', 'latest')).toEqual({
      version: 1, type: 'recipes', sort: 'latest', offset: 24,
    });
    expect(decodePublicSearchCursor(latest, 'recipes')).toBeNull();
    const top = encodePublicSearchCursor({ version: 1, type: 'recipes', offset: 24 });
    expect(decodePublicSearchCursor(top, 'recipes', 'latest')).toBeNull();
  });

  it('rejects hand-built cursors whose id is not a UUID', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, t: 'posts', s: 4.25, i: 'not-a-uuid' }), 'utf8')
      .toString('base64url');
    expect(decodePublicSearchCursor(forged, 'posts')).toBeNull();
  });
});

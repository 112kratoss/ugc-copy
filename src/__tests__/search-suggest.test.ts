import { describe, expect, it } from 'vitest';

import { PUBLIC_SEARCH_READ_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { PUBLIC_SEARCH_MAX_QUERY_LENGTH, normalizeCreatorSearchQuery } from '@/lib/public-search';
import {
  SEARCH_SUGGEST_MAX_COMPLETIONS,
  SEARCH_SUGGEST_MAX_CREATORS,
  SEARCH_SUGGEST_MIN_QUERY_LENGTH,
  SEARCH_SUGGEST_RATE_LIMIT,
  searchSuggestQuery,
} from '@/lib/search-suggest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const contract = mobileApiContract.searchSuggest;

describe('search suggest query', () => {
  it('reads a query as search reads it: trimmed, NFKC, one space between words', () => {
    expect(searchSuggestQuery('  Lu  ')).toEqual({ ok: true, query: 'Lu', normalizedQuery: 'Lu', handlesOnly: false });
    expect(searchSuggestQuery('cinematic \t  po')).toMatchObject({ ok: true, normalizedQuery: 'cinematic po', handlesOnly: false });
    // Full-width letters are the letters they stand for; `query` echoes what was sent.
    expect(searchSuggestQuery('Ｌｕ')).toEqual({ ok: true, query: 'Ｌｕ', normalizedQuery: 'Lu', handlesOnly: false });
    // By search's own normaliser, not a copy of it.
    for (const typed of ['  Lu  ', '@@luna', 'Ｌｕ　ｎａ', 'ça va', '🔥 po']) {
      const read = searchSuggestQuery(typed);
      expect(read.ok && read.normalizedQuery, typed).toBe(normalizeCreatorSearchQuery(typed));
    }
  });

  it('reads a leading @ as asking for handles, and takes it off', () => {
    expect(searchSuggestQuery('@lu')).toEqual({ ok: true, query: '@lu', normalizedQuery: 'lu', handlesOnly: true });
    expect(searchSuggestQuery('  @@Lu')).toEqual({ ok: true, query: '@@Lu', normalizedQuery: 'Lu', handlesOnly: true });
    // Full-width @ is NFKC's @.
    expect(searchSuggestQuery('＠lu')).toMatchObject({ ok: true, normalizedQuery: 'lu', handlesOnly: true });
    // Only at the start: an @ inside is a character of the query.
    expect(searchSuggestQuery('lu@na')).toMatchObject({ ok: true, normalizedQuery: 'lu@na', handlesOnly: false });
  });

  it('leaves no space where the @ was', () => {
    // The normaliser trims before it takes the @ off, which left ` lu`: a query
    // the database reads as `lu` and a client compares with its box as ` lu`.
    expect(searchSuggestQuery('@ lu')).toEqual({ ok: true, query: '@ lu', normalizedQuery: 'lu', handlesOnly: true });
    expect(searchSuggestQuery(' @@  Lu na ')).toEqual({ ok: true, query: '@@  Lu na', normalizedQuery: 'Lu na', handlesOnly: true });
    expect(searchSuggestQuery('@ ')).toEqual({ ok: false, error: 'q must contain at least 1 character.' });
  });

  it('takes control characters out before anything else reads the query', () => {
    // Postgres refuses a text that holds U+0000: `q=a%00` was a 500.
    expect(searchSuggestQuery('a\u0000')).toEqual({ ok: true, query: 'a', normalizedQuery: 'a', handlesOnly: false });
    expect(searchSuggestQuery('\u0000lu\u0000na\u0000')).toEqual({ ok: true, query: 'luna', normalizedQuery: 'luna', handlesOnly: false });
    expect(searchSuggestQuery('\u0000@lu')).toMatchObject({ ok: true, normalizedQuery: 'lu', handlesOnly: true });
    // Every C0 and C1 control and DEL, not NUL alone.
    for (const control of ['\u0001', '\u0008', '\u001b', '\u001f', '\u007f', '\u0085', '\u009f']) {
      expect(searchSuggestQuery(`po${control}rt`), JSON.stringify(control)).toMatchObject({ ok: true, normalizedQuery: 'port' });
    }
    // A tab or a line break is a space between words, as search reads one.
    expect(searchSuggestQuery('cinematic\tpo')).toMatchObject({ ok: true, normalizedQuery: 'cinematic po' });
    expect(searchSuggestQuery('cinematic\r\npo')).toMatchObject({ ok: true, normalizedQuery: 'cinematic po' });
    // Nothing left is nothing typed.
    for (const empty of ['\u0000', '\u0000\u0000', ' \u0000 ', '@\u0000', '\u001b\u007f']) {
      expect(searchSuggestQuery(empty), JSON.stringify(empty)).toEqual({
        ok: false,
        error: 'q must contain at least 1 character.',
      });
    }
    // Control characters are not length: a hundred letters among them still pass.
    expect(searchSuggestQuery(`\u0000${'a'.repeat(PUBLIC_SEARCH_MAX_QUERY_LENGTH)}\u0000`).ok).toBe(true);
    // No normalised query ever holds one.
    for (const typed of ['a\u0000b', '\u0000', 'x\u009fy', '@\u0000 lu']) {
      const read = searchSuggestQuery(typed);
      if (read.ok) expect(read.normalizedQuery).not.toMatch(/\p{Cc}/u);
    }
  });

  it('answers from one character, counted as the database counts them', () => {
    expect(SEARCH_SUGGEST_MIN_QUERY_LENGTH).toBe(1);
    expect(searchSuggestQuery('l').ok).toBe(true);
    // One emoji is one character, where .length says two.
    expect(searchSuggestQuery('🔥').ok).toBe(true);
    for (const empty of [null, undefined, '', '   ', '\t\n', '@', '@@@', ' @ ']) {
      expect(searchSuggestQuery(empty), JSON.stringify(empty)).toEqual({
        ok: false,
        error: 'q must contain at least 1 character.',
      });
    }
  });

  it('refuses a query past search’s own length', () => {
    expect(searchSuggestQuery('a'.repeat(PUBLIC_SEARCH_MAX_QUERY_LENGTH)).ok).toBe(true);
    expect(searchSuggestQuery('a'.repeat(PUBLIC_SEARCH_MAX_QUERY_LENGTH + 1))).toEqual({
      ok: false,
      error: 'q must be at most 100 characters.',
    });
    expect(searchSuggestQuery('a'.repeat(200)).ok).toBe(false);
    // Space around a query of the longest length is not length.
    expect(searchSuggestQuery(`  ${'a'.repeat(PUBLIC_SEARCH_MAX_QUERY_LENGTH)}  `).ok).toBe(true);
  });

  it('passes quotes, wildcards, backslashes and tsquery syntax through as the characters they are', () => {
    for (const odd of ['\'', '"', '%', '_', '\\', 'ar%', 'ar_a', 'a & b', 'a | !b', 'quil:*', '(a', '<->', '🔥🔥', '日本語']) {
      expect(searchSuggestQuery(odd), odd).toEqual({ ok: true, query: odd, normalizedQuery: odd, handlesOnly: false });
    }
  });
});

describe('search suggest limits', () => {
  it('holds a hard cap on each list, as the contract states it', () => {
    expect(SEARCH_SUGGEST_MAX_CREATORS).toBe(5);
    expect(SEARCH_SUGGEST_MAX_COMPLETIONS).toBe(6);
    expect(contract.limits).toEqual({
      minQueryLength: SEARCH_SUGGEST_MIN_QUERY_LENGTH,
      maxQueryLength: PUBLIC_SEARCH_MAX_QUERY_LENGTH,
      maxCreators: SEARCH_SUGGEST_MAX_CREATORS,
      maxCompletions: SEARCH_SUGGEST_MAX_COMPLETIONS,
    });
    expect(contract.response.creators.length).toBeLessThanOrEqual(SEARCH_SUGGEST_MAX_CREATORS);
    expect(contract.response.completions.length).toBeLessThanOrEqual(SEARCH_SUGGEST_MAX_COMPLETIONS);
  });

  it('has a rate limit of its own, sized for typing and apart from full search’s', () => {
    expect(SEARCH_SUGGEST_RATE_LIMIT.scope).toBe('public-search:suggest');
    expect(SEARCH_SUGGEST_RATE_LIMIT.scope).not.toBe(PUBLIC_SEARCH_READ_RATE_LIMIT.scope);
    expect(contract.rateLimit).toEqual(SEARCH_SUGGEST_RATE_LIMIT);
    // Several requests a second in a burst: the window's whole allowance may be
    // spent at once, and it refills within the minute.
    expect(SEARCH_SUGGEST_RATE_LIMIT.limit).toBeGreaterThanOrEqual(60);
    expect(SEARCH_SUGGEST_RATE_LIMIT.windowSeconds).toBeLessThanOrEqual(60);
    // A typed query spends more requests than a search: more room per second than search has.
    expect(SEARCH_SUGGEST_RATE_LIMIT.limit / SEARCH_SUGGEST_RATE_LIMIT.windowSeconds)
      .toBeGreaterThan(PUBLIC_SEARCH_READ_RATE_LIMIT.limit / PUBLIC_SEARCH_READ_RATE_LIMIT.windowSeconds);
  });
});

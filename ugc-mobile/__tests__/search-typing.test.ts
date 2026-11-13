import { describe, expect, it } from 'vitest';

import {
  SEARCH_TYPEAHEAD_OFFER_ALL,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  searchForRowLabel,
  searchTypeaheadAction,
  searchTypeaheadMatchingRecents,
  searchTypeaheadRowLabel,
  searchTypeaheadSections,
  searchTypeaheadTextRuns,
  searchTypingSections,
  type SearchSuggestResponse,
} from '../lib/public-search-policy/search-typeahead';
import {
  searchAsksForResults,
  searchModeAfter,
  searchScreenBody,
  searchTabPressCommits,
  searchTypingAppendedFrom,
  searchTypingHeldLength,
} from '../lib/search-typing-mode';

// The app's typing list (search UX audit 2026-11-13, findings 1 and 9).
describe('the typing list', () => {
  const answer: SearchSuggestResponse = {
    query: 'lum',
    normalizedQuery: 'lum',
    creators: [{ id: 'c1', username: 'luma', displayName: 'Luma', avatarUrl: null, isFollowing: false }],
    entities: [],
    completions: [{ text: 'lumen glow' }, { text: 'luminous' }],
  };
  // The shared sections as the app's hook draws them: with the recents, every kind offered.
  const drawn = (query: string | null, recents: readonly string[], response: SearchSuggestResponse | null = answer) =>
    searchTypeaheadSections(response, query, { recents, offer: SEARCH_TYPEAHEAD_OFFER_ALL });

  it('starts with "Search for", then the recent searches the text matches, then the answer', () => {
    const sections = searchTypingSections({ query: 'lum', sections: drawn('lum', ['Lumen glow']) });
    expect(sections.map((section) => [section.id, section.heading])).toEqual([
      ['search', null],
      // Each recent carries its clock: no heading over them in the typing list.
      ['recents', null],
      ['creators', 'Creators'],
      ['completions', 'Suggested searches'],
    ]);
    expect(sections.flatMap((section) => section.rows.map((row) => row.key))).toEqual([
      'search',
      'recent:lumen glow',
      'creator:c1',
      // "lumen glow" is a recent search already: offered once, as the recent.
      'completion:luminous',
    ]);
  });

  it('is "Search for" alone before any answer, and nothing for an empty field', () => {
    expect(searchTypingSections({ query: 'lu', sections: drawn('lu', [], null) }).flatMap((section) => section.rows))
      .toEqual([{ kind: 'search', key: 'search', text: 'lu' }]);
    expect(searchTypingSections({ query: null, sections: drawn('lum', ['lumen']) })).toEqual([]);
  });

  it('leaves "Search for" out for a text the search would not run (review of #786, S2)', () => {
    const rows = searchTypingSections({ query: 'l', sections: drawn('l', []), searchable: false }).flatMap((section) => section.rows);
    expect(rows.some((row) => row.kind === 'search')).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('names the "Search for" row with the text in quotes, and a recent as searching again', () => {
    expect(searchForRowLabel('nano')).toBe('Search for “nano”');
    expect(searchTypeaheadRowLabel({ kind: 'search', key: 'search', text: 'nano' })).toBe('Search for “nano”');
    const recent = { kind: 'completion' as const, key: 'recent:nano banana', text: 'nano banana', recent: true as const };
    expect(searchTypeaheadRowLabel(recent)).toBe('Search again for nano banana');
    expect(searchTypeaheadAction(recent)).toEqual({ type: 'search', query: 'nano banana' });
    expect(searchTypeaheadAction({ kind: 'search', key: 'search', text: 'nano' })).toEqual({ type: 'search', query: 'nano' });
  });

  // The shared rules the web's box draws by too (search-typeahead-policy.test.ts holds them in full).
  it('offers the recent searches the text begins, or begins a word of, never the text itself, at most three', () => {
    const history = ['neon portrait', 'portrait', 'Portrait lighting', 'port city', 'sport', 'portraits'];
    expect(searchTypeaheadMatchingRecents(history, 'port')).toEqual(['neon portrait', 'portrait', 'Portrait lighting']);
    expect(searchTypeaheadMatchingRecents(history, 'portrait')).toEqual(['neon portrait', 'Portrait lighting', 'portraits']);
    expect(searchTypeaheadMatchingRecents(history, 'neon por')).toEqual(['neon portrait']);
    expect(searchTypeaheadMatchingRecents(history, null)).toEqual([]);
  });

  it('marks the part of a row already typed, so the rest can be emphasised, and keeps the words whole', () => {
    expect(searchTypeaheadTextRuns('Neon Portrait', 'por')).toEqual([
      { text: 'Neon ', typed: false },
      { text: 'Por', typed: true },
      { text: 'trait', typed: false },
    ]);
    expect(searchTypeaheadTextRuns('sport', 'port')).toEqual([{ text: 'sport', typed: false }]);
    for (const [text, query] of [['nano banana pro', 'nano'], ['Neon Portrait', 'por'], ['İstanbul', 'i']] as const) {
      expect(searchTypeaheadTextRuns(text, query).map((run) => run.text).join('')).toBe(text);
    }
  });
});

describe('the search screen\'s two modes', () => {
  it('is typing from a focus or an edit until a commit, and asks for results only then', () => {
    expect(searchModeAfter('typing', 'commit')).toBe('results');
    expect(searchModeAfter('results', 'focus')).toBe('typing');
    expect(searchModeAfter('results', 'edit')).toBe('typing');
    expect(searchAsksForResults('typing')).toBe(false);
    expect(searchAsksForResults('results')).toBe(true);
  });

  it('draws the start for an empty field, the list while typing, the results after a commit', () => {
    expect(searchScreenBody({ mode: 'typing', text: '' })).toBe('start');
    expect(searchScreenBody({ mode: 'results', text: '  ' })).toBe('start');
    expect(searchScreenBody({ mode: 'typing', text: '@' })).toBe('start');
    expect(searchScreenBody({ mode: 'typing', text: 'n' })).toBe('suggestions');
    expect(searchScreenBody({ mode: 'results', text: 'nano' })).toBe('results');
  });

  it('commits what is typed when a tab is pressed while typing, and only then', () => {
    expect(searchTabPressCommits({ mode: 'typing', text: 'nano' })).toBe(true);
    expect(searchTabPressCommits({ mode: 'typing', text: '' })).toBe(false);
    expect(searchTabPressCommits({ mode: 'results', text: 'nano' })).toBe(false);
  });

  it('finds rows only added under the list as it stood, and nothing when a row above moved', () => {
    expect(searchTypingAppendedFrom(['search'], ['search', 'creator:a', 'completion:b'])).toBe(1);
    expect(searchTypingAppendedFrom(['search', 'recent:x'], ['search', 'recent:x', 'creator:a'])).toBe(2);
    expect(searchTypingAppendedFrom(['search', 'creator:a'], ['search', 'recent:x', 'creator:a'])).toBeNull();
    expect(searchTypingAppendedFrom(['search', 'creator:a'], ['search', 'creator:a'])).toBeNull();
    expect(searchTypingAppendedFrom([], ['search'])).toBe(0);
  });

  it('does not count a row added where another stood a moment before as added under the list (review of #786, M1)', () => {
    // Four rows, a letter shortens the list to three, and the answer adds one
    // in the fourth place again: something stood there 140 ms ago.
    expect(searchTypingAppendedFrom(['search', 'recent:a', 'completion:b'], ['search', 'recent:a', 'completion:b', 'completion:c'], 4)).toBeNull();
    // Rows past the place that was held still count as added.
    expect(searchTypingAppendedFrom(['search', 'recent:a', 'completion:b'], ['search', 'recent:a', 'completion:b', 'completion:c', 'completion:d'], 4)).toBe(4);
  });

  it('keeps the places held until the order has stood still for the press rule', () => {
    const SETTLE = SEARCH_TYPEAHEAD_PRESS_SETTLE_MS;
    expect(searchTypingHeldLength(null, 3, 1000)).toEqual({ length: 3, changedAt: 1000 });
    // A letter takes a row away 140 ms after a change: the fourth place still counts.
    expect(searchTypingHeldLength({ length: 3, changedAt: 1000 }, 4, 1140)).toEqual({ length: 4, changedAt: 1140 });
    expect(searchTypingHeldLength({ length: 4, changedAt: 1140 }, 3, 1280)).toEqual({ length: 4, changedAt: 1280 });
    // Once the order has stood, only the rows on show count.
    expect(searchTypingHeldLength({ length: 4, changedAt: 1280 }, 3, 1280 + SETTLE)).toEqual({ length: 3, changedAt: 1280 + SETTLE });
  });
});

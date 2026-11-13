import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SEARCH_FIELD_LABEL,
  SEARCH_IDLE_BODY,
  SEARCH_IDLE_TITLE,
  SEARCH_PLACEHOLDER,
  SEARCH_RECENTS_CLEAR_LABEL,
  SEARCH_SORT_OPTIONS,
  SEARCH_TABS,
  searchHistoryQueryFor,
  searchSaysNoResults,
  searchTabRuns,
} from '../lib/public-search-policy/public-search-policy';
import { searchPostGridCellWidth, searchPostGridColumns } from '../lib/search-post-grid';

// The words the app's search shares with the web (search UX audit,
// 2026-11-13, finding 10), asserted as the app reads them; the web's side is
// src/__tests__/public-search-policy.test.ts.
describe('the search words the app shows', () => {
  it('are the shared ones', () => {
    expect(SEARCH_PLACEHOLDER).toBe('Search');
    expect(SEARCH_FIELD_LABEL).toBe('Search creators, posts, and recipes');
    expect(SEARCH_IDLE_TITLE).toBe('Find creators, posts and recipes');
    expect(SEARCH_IDLE_BODY).not.toMatch(/character/i);
    expect(SEARCH_RECENTS_CLEAR_LABEL).toBe('Clear all');
    expect(SEARCH_TABS.map((tab) => tab.label)).toEqual(['Top', 'Creators', 'Posts', 'Recipes']);
    expect(SEARCH_SORT_OPTIONS.map((option) => option.label)).toEqual(['Best match', 'Latest']);
  });

  it('live in the shared module, not in a copy of the overlay\'s own', () => {
    const overlay = readFileSync(join(__dirname, '../components/explore-search-overlay.tsx'), 'utf8');
    for (const word of ['Search Magicbooklet', 'Search Magic Booklet', 'Find your next idea', 'Search did not load', 'Retry search', "label: 'Top'", 'two characters, or']) {
      expect(overlay.includes(word), word).toBe(false);
    }
  });

  it('search a tab from its own minimum and give no verdict on half a word', () => {
    expect(searchTabRuns('top', 2)).toBe(true);
    expect(searchTabRuns('posts', 2)).toBe(false);
    expect(searchSaysNoResults(2)).toBe(false);
  });

  it('keep a search among the recent ones as it was read', () => {
    expect(searchHistoryQueryFor({ query: 'portriat', type: 'top', correctedQuery: { posts: 'portrait', recipes: null }, exact: false }))
      .toBe('portrait');
  });
});

describe('the app search\'s post grid', () => {
  it('is two across at the standard text sizes and one across from the first accessibility size', () => {
    // iOS: Large 1.0, xxxLarge about 1.35, AX1 about 1.65.
    for (const scale of [undefined, 0.82, 1, 1.24, 1.35]) expect(searchPostGridColumns(scale), String(scale)).toBe(2);
    for (const scale of [1.65, 2, 3.12]) expect(searchPostGridColumns(scale), String(scale)).toBe(1);
    expect(searchPostGridCellWidth(2)).toBe('48%');
    expect(searchPostGridCellWidth(1)).toBe('100%');
  });
});

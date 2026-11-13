import { describe, expect, it } from 'vitest';

import {
  SEARCH_EMPTY_TAB_POINTER_ORDER,
  searchEmptyTabPointer,
  searchEmptyTabPointerLine,
  searchEmptyTabTitle,
  searchSeeTabLabel,
} from '../lib/public-search-policy/public-search-policy';

// An empty tab says what another holds (search UX audit 2026-11-13, finding 8),
// by the web's shared rule (#790): the app draws these words as they are.
const top = (creators: number, posts: number, recipes: number) => ({
  creators: { items: Array.from({ length: creators }) },
  posts: { items: Array.from({ length: posts }) },
  recipes: { items: Array.from({ length: recipes }) },
});

describe('an empty tab\'s pointer to another, as the app draws it', () => {
  it('names the empty tab and the query, and the way to the other', () => {
    expect(searchEmptyTabTitle('recipes', 'nano')).toBe('No recipes for “nano”');
    expect(searchSeeTabLabel('posts')).toBe('See posts');
  });

  it('points to the first of posts, creators and recipes that holds something, never the tab itself', () => {
    expect(SEARCH_EMPTY_TAB_POINTER_ORDER).toEqual(['posts', 'creators', 'recipes']);
    expect(searchEmptyTabPointer('recipes', top(2, 4, 0))).toMatchObject({ tab: 'posts', count: 4 });
    expect(searchEmptyTabPointer('posts', top(2, 0, 3))).toMatchObject({ tab: 'creators', count: 2 });
    expect(searchEmptyTabPointer('posts', top(0, 9, 0))).toBeNull();
  });

  it('counts what Top showed, a full section as more', () => {
    expect(searchEmptyTabPointerLine(searchEmptyTabPointer('recipes', top(0, 12, 0))!)).toBe('12+ posts match');
    expect(searchEmptyTabPointerLine(searchEmptyTabPointer('recipes', top(0, 3, 0))!)).toBe('3 posts match');
    expect(searchEmptyTabPointerLine(searchEmptyTabPointer('posts', top(1, 0, 0))!)).toBe('1 creator matches');
  });
});

import { describe, expect, it } from 'vitest';

import {
  searchEmptyTabTitle,
  searchOtherTabLine,
  searchOtherTabPointer,
  searchSeeTabLabel,
} from '../lib/public-search-policy/public-search-policy';

// An empty tab says what another holds (search UX audit 2026-11-13, finding 8).
describe('an empty tab\'s pointer to another', () => {
  it('names the empty tab and the query', () => {
    expect(searchEmptyTabTitle('recipes', 'nano')).toBe('No recipes for “nano”');
    expect(searchSeeTabLabel('posts')).toBe('See posts');
  });

  it('counts what Top showed, a full section as more', () => {
    expect(searchOtherTabLine('posts', 12)).toBe('12+ posts match');
    expect(searchOtherTabLine('posts', 3)).toBe('3 posts match');
    expect(searchOtherTabLine('creators', 1)).toBe('1 creator matches');
    expect(searchOtherTabLine('creators', 5)).toBe('5+ creators match');
    expect(searchOtherTabLine('recipes', 2)).toBe('2 recipes match');
  });

  it('points to the first of posts, creators and recipes that holds something, never the tab itself', () => {
    expect(searchOtherTabPointer('recipes', { creators: 2, posts: 4, recipes: 0 })).toEqual({ tab: 'posts', line: '4 posts match', label: 'See posts' });
    expect(searchOtherTabPointer('posts', { creators: 2, posts: 0, recipes: 3 })).toEqual({ tab: 'creators', line: '2 creators match', label: 'See creators' });
    expect(searchOtherTabPointer('creators', { creators: 0, posts: 0, recipes: 1 })).toEqual({ tab: 'recipes', line: '1 recipe matches', label: 'See recipes' });
    expect(searchOtherTabPointer('posts', { creators: 0, posts: 9, recipes: 0 })).toBeNull();
  });
});

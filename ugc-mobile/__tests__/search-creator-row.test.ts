import { describe, expect, it } from 'vitest';

import { SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE } from '../lib/search-post-grid';
import { searchCreatorFollowStacks } from '../lib/search-creator-row';

// A creator row of search at the accessibility text sizes (review of #828, S9):
// Follow stands under the creator's name where the posts go one across.
describe('where a creator row of search draws Follow', () => {
  it('beside the name at the standard sizes, under it from the first accessibility size', () => {
    expect(searchCreatorFollowStacks(undefined)).toBe(false);
    expect(searchCreatorFollowStacks(1)).toBe(false);
    // iOS xxxLarge, the largest standard size.
    expect(searchCreatorFollowStacks(1.35)).toBe(false);
    expect(searchCreatorFollowStacks(SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE)).toBe(true);
    // iOS AX1 and AX3.
    expect(searchCreatorFollowStacks(1.65)).toBe(true);
    expect(searchCreatorFollowStacks(2.35)).toBe(true);
  });
});

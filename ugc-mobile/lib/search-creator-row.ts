import { SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE } from './search-post-grid';

/**
 * Whether a creator row of search, a result's or the start's, stands its
 * Follow under the creator's name rather than beside it: at the accessibility
 * text sizes, where the posts go one across (search-post-grid.ts). Beside a
 * 112 pt button the name, handle and count of a 375 pt phone at AX3 have about
 * 100 pt, and the count alone runs under the button (review of #828, S9).
 */
export function searchCreatorFollowStacks(fontScale: number | undefined): boolean {
  return (fontScale ?? 1) >= SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE;
}

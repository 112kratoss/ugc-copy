/**
 * How many posts the app's search draws across, by the text size the phone is
 * set to. Two across at the standard sizes; one across at the accessibility
 * sizes, where two-across cards cut a title to a word ("Hyper…") and a count
 * to "0 sav…" (search UX audit, 2026-11-13, finding 13).
 *
 * React Native's fontScale on iOS: Large 1.0, xxxLarge about 1.35, the first
 * accessibility size (AX1) about 1.65. Android's largest standard size is 1.3
 * on most phones and 2.0 since Android 14's nonlinear scaling.
 */
export const SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE = 1.5;

export function searchPostGridColumns(fontScale: number | undefined): 1 | 2 {
  return (fontScale ?? 1) >= SEARCH_POST_GRID_ONE_ACROSS_FONT_SCALE ? 1 : 2;
}

/** A post card's width in the grid: about half, less the gap, or the whole row. */
export function searchPostGridCellWidth(columns: 1 | 2): '100%' | '48%' {
  return columns === 1 ? '100%' : '48%';
}

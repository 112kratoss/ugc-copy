import { router } from 'expo-router';

import type { SearchEntranceKind } from './search-entrance';
import { createSearchScreenOpener } from './search-screen-route';

/** The one opener of the search screen every entry shares (createSearchScreenOpener). */
export const searchScreenOpener = createSearchScreenOpener({
  push: (href) => router.push(href),
  now: () => Date.now(),
});

export function openSearchScreen(): void {
  searchScreenOpener.open();
}

/** What an entry hands over: the pressed control's view, which can say where it is in the window. */
type MeasurableView = {
  measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};

/**
 * How long a press waits for the control's measure before opening search
 * without it: a detached view never answers (review of #812, 2).
 */
export const SEARCH_OPEN_MEASURE_WAIT_MS = 32;

/**
 * Opens search out of the pressed control, so the field grows from it
 * (lib/search-entrance.ts). On Fabric the measure answers before this returns;
 * a view that cannot be measured, or does not answer within
 * SEARCH_OPEN_MEASURE_WAIT_MS, opens search as `openSearchScreen` does.
 */
export function openSearchScreenFrom(view: MeasurableView | null, kind: SearchEntranceKind): void {
  if (typeof view?.measureInWindow !== 'function') {
    openSearchScreen();
    return;
  }
  let opened = false;
  const open = (from: Parameters<typeof searchScreenOpener.open>[0]) => {
    if (opened) return;
    opened = true;
    searchScreenOpener.open(from);
  };
  try {
    view.measureInWindow((x, y, width, height) => open({ x, y, width, height, kind }));
  } catch {
    // Measured or not, the press opens search.
  }
  if (!opened) setTimeout(() => open(null), SEARCH_OPEN_MEASURE_WAIT_MS);
}

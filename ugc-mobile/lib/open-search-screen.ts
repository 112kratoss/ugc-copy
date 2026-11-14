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
 * Opens search out of the pressed control, so the field grows from it
 * (lib/search-entrance.ts). On Fabric the measure answers before this returns;
 * a view that cannot be measured opens search as `openSearchScreen` does.
 */
export function openSearchScreenFrom(view: MeasurableView | null, kind: SearchEntranceKind): void {
  if (typeof view?.measureInWindow !== 'function') {
    searchScreenOpener.open();
    return;
  }
  let opened = false;
  view.measureInWindow((x, y, width, height) => {
    if (opened) return;
    opened = true;
    searchScreenOpener.open({ x, y, width, height, kind });
  });
}

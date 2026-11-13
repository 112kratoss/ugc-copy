import { router } from 'expo-router';

import { createSearchScreenOpener } from './search-screen-route';

/** The one opener of the search screen every entry shares (createSearchScreenOpener). */
export const searchScreenOpener = createSearchScreenOpener({
  push: (href) => router.push(href),
  now: () => Date.now(),
});

export function openSearchScreen(): void {
  searchScreenOpener.open();
}

/**
 * Whether Back would land on `path` (an internal path, with its query) within
 * this document: the entry before this one in the tab's history, as the
 * Navigation API lists it. False where the browser has no Navigation API, and
 * when the entry before is another address, another document's, or none. A
 * page leaving for where it was opened from steps back when this is true,
 * rather than put a second entry for the same page behind it, and goes there
 * by a replace otherwise.
 */

// The part of the Navigation API read here: TypeScript's DOM types do not
// declare `window.navigation`.
type TabHistory = {
  currentEntry: { index: number } | null;
  entries(): Array<{ url: string | null; sameDocument: boolean }>;
};

export function isPreviousHistoryEntry(path: string): boolean {
  if (typeof window === 'undefined') return false;
  const tabHistory = (window as Window & { navigation?: TabHistory }).navigation;
  const current = tabHistory?.currentEntry;
  if (!tabHistory || !current || current.index < 1) return false;
  const previousEntry = tabHistory.entries()[current.index - 1];
  // Another document's entry is loaded anew, or brought back from the
  // back-forward cache as it was before the change, never drawn afresh by
  // this document's router.
  if (!previousEntry?.url || !previousEntry.sameDocument) return false;

  const previous = new URL(previousEntry.url);
  const target = new URL(path, window.location.origin);
  return previous.origin === target.origin
    && previous.pathname === target.pathname
    && sortedQuery(previous) === sortedQuery(target);
}

function sortedQuery(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.sort();
  return params.toString();
}

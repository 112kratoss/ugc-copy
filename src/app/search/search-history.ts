import {
  SEARCH_HISTORY_KEY,
  parseSearchHistory,
  searchHistoryWith,
  searchHistoryWithout,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * Recent searches on the web: kept in this browser's localStorage and nowhere
 * else, under the rules the app's list follows
 * (ugc-mobile/lib/public-search-policy: at most ten, a search replacing the
 * steps of typing it). Every read and write is guarded: a private window, a
 * full store or a browser with storage switched off throws on access, and
 * search must work the same without a list.
 */

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function write(next: string[]): string[] {
  try {
    storage()?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Not kept: the list on screen still follows what the person did.
  }
  return next;
}

export function readSearchHistory(): string[] {
  try {
    return parseSearchHistory(storage()?.getItem(SEARCH_HISTORY_KEY));
  } catch {
    return [];
  }
}

/** The list with this search at its head; unchanged for a query too short to keep. */
export function rememberSearchQuery(query: string): string[] {
  const current = readSearchHistory();
  const next = searchHistoryWith(current, query);
  return next ? write(next) : current;
}

export function forgetSearchQuery(query: string): string[] {
  return write(searchHistoryWithout(readSearchHistory(), query));
}

export function clearSearchHistory(): string[] {
  try {
    storage()?.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    // Nothing to clear where nothing could be kept.
  }
  return [];
}

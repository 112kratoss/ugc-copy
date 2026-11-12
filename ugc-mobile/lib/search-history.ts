import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  SEARCH_HISTORY_KEY,
  parseSearchHistory,
  searchHistoryWith,
  searchHistoryWithout,
} from './public-search-policy/public-search-policy';

// The rules (what is kept, how a new search joins the list, how many) are the
// one copy the web's search page shares: lib/public-search-policy. This file
// brings the app's storage.
export {
  normalizeCreatorSearchQuery,
  normalizeSearchHistoryQuery,
  searchQueryLength,
} from './public-search-policy/public-search-policy';

type SearchHistoryStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

export async function readSearchHistory(storage: SearchHistoryStorage = AsyncStorage) {
  try {
    return parseSearchHistory(await storage.getItem(SEARCH_HISTORY_KEY));
  } catch {
    return [];
  }
}

export async function rememberSearchQuery(query: string, storage: SearchHistoryStorage = AsyncStorage) {
  const current = await readSearchHistory(storage);
  const next = searchHistoryWith(current, query);
  if (!next) return current;
  await storage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export async function forgetSearchQuery(query: string, storage: SearchHistoryStorage = AsyncStorage) {
  const next = searchHistoryWithout(await readSearchHistory(storage), query);
  await storage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

/** Never rejects: a sign-out must not fail over a list of searches. */
export async function clearSearchHistory(storage: SearchHistoryStorage = AsyncStorage) {
  try {
    await storage.removeItem(SEARCH_HISTORY_KEY);
  } catch (error) {
    console.warn('Could not clear recent searches', error);
  }
}

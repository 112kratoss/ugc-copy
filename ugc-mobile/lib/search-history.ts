import AsyncStorage from '@react-native-async-storage/async-storage';

const SEARCH_HISTORY_KEY = 'magicbooklet:public-search-history:v1';
const SEARCH_HISTORY_LIMIT = 10;

type SearchHistoryStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

export function normalizeSearchHistoryQuery(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 100);
}

/**
 * The server's rule of the same name (src/lib/public-search.ts): it strips
 * leading @ before its two- and three-character checks, so "@j" counts as one
 * character. The length gates count what the server counts.
 */
export function normalizeCreatorSearchQuery(value: string | null | undefined): string {
  return normalizeSearchHistoryQuery(value ?? '').replace(/^@+/, '');
}

export async function readSearchHistory(storage: SearchHistoryStorage = AsyncStorage) {
  try {
    const raw = await storage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeSearchHistoryQuery)
      .filter((value) => value.length >= 2)
      .slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export async function rememberSearchQuery(query: string, storage: SearchHistoryStorage = AsyncStorage) {
  const normalized = normalizeSearchHistoryQuery(query);
  if (normalized.length < 2) return readSearchHistory(storage);
  const current = await readSearchHistory(storage);
  const lowered = normalized.toLocaleLowerCase();
  // An entry the new query extends was a step on the way to it ("po" and "por"
  // before "port"); an exact repeat is its own prefix.
  const next = [normalized, ...current.filter((item) => !lowered.startsWith(item.toLocaleLowerCase()))]
    .slice(0, SEARCH_HISTORY_LIMIT);
  await storage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export async function forgetSearchQuery(query: string, storage: SearchHistoryStorage = AsyncStorage) {
  const normalized = normalizeSearchHistoryQuery(query);
  const current = await readSearchHistory(storage);
  const next = current.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
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

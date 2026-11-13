import { readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';

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
 *
 * They end at sign-out, as the app's do (its sign-out clears them,
 * ugc-mobile/lib/auth.tsx): on a shared browser the next person must not be
 * shown what the last account searched for. The app clears at the sign-out
 * itself; a web sign-out can happen on any page, or in another tab, so the
 * list also remembers which account kept it (SEARCH_HISTORY_OWNER_KEY) and a
 * read by anyone else, or by nobody, finds it gone. A list a visitor kept
 * stays through a sign-in, as on the app, and becomes that account's at its
 * next search.
 */

/** The account a kept list belongs to; absent for a visitor's. */
export const SEARCH_HISTORY_OWNER_KEY = 'magicbooklet:public-search-history-owner:v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The account this browser's session cookie names: a hint of whose browser it is now, never proof. */
function currentAccountId(): string | null {
  try {
    return readSupabaseAuthCookieUserId();
  } catch {
    return null;
  }
}

function write(next: string[], accountId: string | null): string[] {
  try {
    const store = storage();
    store?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    if (accountId) store?.setItem(SEARCH_HISTORY_OWNER_KEY, accountId);
  } catch {
    // Not kept: the list on screen still follows what the person did.
  }
  return next;
}

export function readSearchHistory(accountId: string | null = currentAccountId()): string[] {
  try {
    const store = storage();
    const owner = store?.getItem(SEARCH_HISTORY_OWNER_KEY) ?? null;
    // Kept by an account that is not the one here now: signed out, or another signed in.
    if (owner && owner !== accountId) return clearSearchHistory();
    return parseSearchHistory(store?.getItem(SEARCH_HISTORY_KEY));
  } catch {
    return [];
  }
}

/** The list with this search at its head; unchanged for a query too short to keep. */
export function rememberSearchQuery(query: string, accountId: string | null = currentAccountId()): string[] {
  const current = readSearchHistory(accountId);
  const next = searchHistoryWith(current, query);
  return next ? write(next, accountId) : current;
}

export function forgetSearchQuery(query: string, accountId: string | null = currentAccountId()): string[] {
  return write(searchHistoryWithout(readSearchHistory(accountId), query), accountId);
}

export function clearSearchHistory(): string[] {
  try {
    const store = storage();
    store?.removeItem(SEARCH_HISTORY_KEY);
    store?.removeItem(SEARCH_HISTORY_OWNER_KEY);
  } catch {
    // Nothing to clear where nothing could be kept.
  }
  return [];
}

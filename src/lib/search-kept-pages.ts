import { readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';

/**
 * The searches this tab has left, kept so that Back or Forward to one draws
 * what was on screen (the answer, the pages "Show more" added) at the place
 * the person had scrolled to, without asking the server again (search UX audit
 * 2026-11-13, finding 6: Back came back to the top and asked again).
 *
 * - Bounded: the last SEARCH_KEPT_PAGES_LIMIT addresses, most recent first,
 *   each for SEARCH_KEPT_PAGE_LIFETIME_MS at most.
 * - This tab's session only: `sessionStorage`, which another tab never reads
 *   and which ends with the tab. Every read and write is guarded: a private
 *   window or a full store throws, and search then works as before.
 * - One account's: each entry names the account its answer was ASKED for (a
 *   guest's or none for a visitor), never whoever is signed in when it is
 *   kept, and is drawn only while the session cookie names that same account.
 *   The search page drops them all when the account changes.
 * - Dropped when the viewer changes what a search would show them
 *   (`forgetKeptSearchPages`): a block or a report, a change to or the delete
 *   of their own post, a recipe unlocked. What has no hook here (a change made
 *   in another tab, a follow) waits out the lifetime.
 * - Read only for a mount that Back or Forward landed on
 *   (`readSearchPageAddress` in src/app/search/search-address.ts says when): a
 *   fresh visit to the same address asks the server as it always did.
 */

// v2: entries name the asking account and the time they were kept (2026-11-13).
export const SEARCH_KEPT_PAGES_KEY = 'magicbooklet:search-kept-pages:v2';
export const SEARCH_KEPT_PAGES_LIMIT = 5;
export const SEARCH_KEPT_PAGE_LIFETIME_MS = 30 * 60 * 1000;

export type KeptSearchPage<T> = {
  /** The page's address, path and query, exactly as the browser shows it. */
  address: string;
  /** What was on screen: the page's own answer, as it keeps it. */
  answer: T;
  /** How far the window was scrolled. */
  scrollY: number;
  /** The account the answer was asked for; null for a visitor's. */
  accountId: string | null;
  /** When it was kept (a clock's milliseconds). */
  keptAt: number;
};

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The account the session cookie names now: a hint, never proof, as the recent searches read it. */
export function keptSearchPagesViewerHint(): string | null {
  try {
    return readSupabaseAuthCookieUserId();
  } catch {
    return null;
  }
}

function isEntry(entry: unknown): entry is KeptSearchPage<unknown> {
  if (typeof entry !== 'object' || entry === null) return false;
  const kept = entry as KeptSearchPage<unknown>;
  return typeof kept.address === 'string'
    && typeof kept.scrollY === 'number'
    && typeof kept.keptAt === 'number'
    && (kept.accountId === null || typeof kept.accountId === 'string')
    && 'answer' in kept;
}

function readAll(now: number): KeptSearchPage<unknown>[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(SEARCH_KEPT_PAGES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).filter((entry) => now - entry.keptAt < SEARCH_KEPT_PAGE_LIFETIME_MS);
  } catch {
    return [];
  }
}

function writeAll(entries: KeptSearchPage<unknown>[]): void {
  const store = storage();
  if (!store) return;
  // A full store refuses the write: the oldest goes until it fits, or none is kept.
  for (let kept = entries.slice(0, SEARCH_KEPT_PAGES_LIMIT); ; kept = kept.slice(0, -1)) {
    try {
      if (kept.length === 0) store.removeItem(SEARCH_KEPT_PAGES_KEY);
      else store.setItem(SEARCH_KEPT_PAGES_KEY, JSON.stringify(kept));
      return;
    } catch {
      if (kept.length === 0) return;
    }
  }
}

/** Keeps what an address shows, asked for `accountId`, at the head of the list, in place of what it showed before. */
export function keepSearchPage<T>(
  address: string,
  answer: T,
  scrollY: number,
  accountId: string | null,
  now: number = Date.now(),
): void {
  const entry: KeptSearchPage<T> = {
    address,
    answer,
    // A scroll that is not a number (a window with none to report) keeps the top.
    scrollY: Number.isFinite(scrollY) ? Math.max(0, Math.round(scrollY)) : 0,
    accountId,
    keptAt: now,
  };
  writeAll([entry, ...readAll(now).filter((kept) => kept.address !== address)]);
}

/**
 * What was kept for this address, asked for this same account, within its
 * lifetime and in the shape `isAnswer` accepts (a tab that spans a deploy may
 * hold an older shape), or null.
 */
export function readKeptSearchPage<T>(
  address: string,
  isAnswer: (answer: unknown) => answer is T,
  accountId: string | null = keptSearchPagesViewerHint(),
  now: number = Date.now(),
): KeptSearchPage<T> | null {
  const kept = readAll(now).find((entry) => entry.address === address);
  if (!kept || kept.accountId !== accountId || !isAnswer(kept.answer)) return null;
  return kept as KeptSearchPage<T>;
}

/** Drops every kept search: the account changed, or the viewer changed what a search shows them. */
export function forgetKeptSearchPages(): void {
  try {
    storage()?.removeItem(SEARCH_KEPT_PAGES_KEY);
  } catch {
    // Nothing was kept where nothing could be.
  }
}

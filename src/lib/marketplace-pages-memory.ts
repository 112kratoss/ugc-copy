import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';
import { readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';

/**
 * The recipes "Load more recipes" brought to a Marketplace listing, kept for this tab (owner's
 * report, 2026-11-15: Back from a recipe drew the first four alone, so the recipe the reader had
 * opened and their place on the page were gone). Opening a recipe unmounts the listing, so what
 * was loaded after its first page lives only in React state; this keeps it in session storage,
 * one entry per listing address and viewer, and gives it back when the listing is drawn again:
 * at once, as it was left, and behind the fresh first page when that arrives.
 *
 * Never from before this document loaded, as Explore's snapshots (a reload starts the listing
 * at its first page), nor older than ten minutes. A creator blocked meanwhile is taken out of
 * what is kept (`takeBlockedCreatorOffMarketplacePages`), and the tab keeps a few listings of
 * bounded length, so session storage stays free for the feeds' snapshots (review of #815).
 */

export interface MarketplacePagesInfo {
  hasMore: boolean;
  nextOffset: number | null;
  offset: number;
  limit: number;
}

export interface MarketplacePages {
  items: MarketplaceResourceListItem[];
  pageInfo: MarketplacePagesInfo;
}

interface RememberedPages extends MarketplacePages {
  savedAt: number;
}

export const MARKETPLACE_PAGES_MEMORY_TTL_MS = 10 * 60_000;
/** Listings kept at once: the one written longest ago makes room for a new one. */
export const MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS = 4;
/** The longest listing kept: its first page and ten more. A longer one is not kept. */
export const MARKETPLACE_PAGES_MEMORY_MAX_ITEMS = 124;
const STORAGE_PREFIX = 'marketplace-pages:';

/**
 * One listing as one viewer sees it: its filters and search (`marketplaceFiltersKey`, the same
 * from the page's shell and its interactive browser), and whose blocks it leaves out.
 */
export function buildMarketplacePagesKey(listingKey: string, viewerId: string | null): string {
  return `${STORAGE_PREFIX}${viewerId ?? 'visitor'}:${encodeURIComponent(listingKey)}`;
}

/**
 * Whose kept listing a page may draw: the signed-in viewer's once the page's auth provider knows
 * them, and while it is still asking, the account this browser's session cookie names (a hint,
 * never proof, as search's kept pages read it). Every mount of the Marketplace's optional-auth
 * provider asks Supabase again who is signed in, about 0.3 s, Back's mount included; read as
 * nobody meanwhile, Back looked for a visitor's listing, drew the first page alone, and the browser
 * put the reader back on that short page (owner's recording, 2026-11-16). A listing is kept under
 * the account its pages were asked for (the session that sent them, or none), so a page asked as
 * a visitor is never drawn as a signed-in viewer's.
 */
export function marketplacePagesViewer({ userId, isLoading }: { userId: string | null; isLoading: boolean }): string | null {
  if (userId) return userId;
  return isLoading ? readSupabaseAuthCookieUserId() : null;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readEntry(store: Storage, key: string): RememberedPages | null {
  try {
    const raw = store.getItem(key);
    const entry = raw ? JSON.parse(raw) as RememberedPages : null;
    return entry && Array.isArray(entry.items) && entry.pageInfo && typeof entry.savedAt === 'number' ? entry : null;
  } catch {
    return null;
  }
}

function writeEntry(store: Storage, key: string, entry: RememberedPages) {
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage full or refused: this listing comes back at its first page, as before.
    store.removeItem(key);
  }
}

function keptKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Written before this document loaded (a reload, a tab opened from this one), or too long ago. */
function isStale(entry: RememberedPages, now: number) {
  return entry.savedAt < performance.timeOrigin || now - entry.savedAt > MARKETPLACE_PAGES_MEMORY_TTL_MS;
}

/** Drops what can no longer be given back, then the oldest, to leave room for one more. */
function makeRoom(store: Storage, now: number) {
  const live: Array<{ key: string; savedAt: number }> = [];
  for (const key of keptKeys(store)) {
    const entry = readEntry(store, key);
    if (!entry || isStale(entry, now)) store.removeItem(key);
    else live.push({ key, savedAt: entry.savedAt });
  }
  live.sort((left, right) => left.savedAt - right.savedAt);
  while (live.length >= MARKETPLACE_PAGES_MEMORY_MAX_LISTINGS) {
    store.removeItem(live.shift()!.key);
  }
}

/**
 * Keeps the listing as drawn, when it holds more than its first page (`firstPageLength` recipes);
 * a listing back at its first page, or longer than the cap, keeps nothing.
 */
export function rememberMarketplacePages(key: string, firstPageLength: number, listing: MarketplacePages): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(key);
    if (listing.items.length <= firstPageLength || listing.items.length > MARKETPLACE_PAGES_MEMORY_MAX_ITEMS) return;
    const now = Date.now();
    makeRoom(store, now);
    writeEntry(store, key, { items: listing.items, pageInfo: listing.pageInfo, savedAt: now });
  } catch {
    // Storage refused: the listing comes back at its first page, as before.
  }
}

/** The listing as it was left; null when nothing was kept for it in this document lately. */
export function recallMarketplacePages(key: string): MarketplacePages | null {
  const store = sessionStore();
  const entry = store ? readEntry(store, key) : null;
  if (!entry || isStale(entry, Date.now())) return null;
  return { items: entry.items, pageInfo: entry.pageInfo };
}

/**
 * A listing's first page with what was kept of it behind: the fresh page's own copies first
 * (a price read in the viewer's currency), then every kept recipe it does not hold, which carries
 * on where the listing was left. The first page alone when nothing was kept.
 */
export function withRememberedPages(firstPage: MarketplacePages, remembered: MarketplacePages | null): MarketplacePages {
  if (!remembered) return firstPage;
  const onFirstPage = new Set(firstPage.items.map((item) => item.id));
  const later = remembered.items.filter((item) => !onFirstPage.has(item.id));
  return later.length > 0
    ? { items: [...firstPage.items, ...later], pageInfo: remembered.pageInfo }
    : firstPage;
}

const FILTERS_OPEN_KEY = 'marketplace-filters-open';

interface RememberedFiltersOpen {
  listingKey: string;
  savedAt: number;
}

/**
 * The filters a phone or a tablet folds behind Filters, left open on a listing (review of #837):
 * Back from a recipe draws them open again, so the page above the grid is as tall as when the
 * reader left it and the browser puts them back on their recipe, a panel's height off otherwise.
 * One listing at a time, `marketplaceFiltersKey`'s; folded is the default and keeps nothing. As the
 * kept pages are, never from before this document loaded, nor older than ten minutes.
 */
export function rememberMarketplaceFiltersOpen(listingKey: string, open: boolean): void {
  const store = sessionStore();
  if (!store) return;
  try {
    if (open) {
      store.setItem(FILTERS_OPEN_KEY, JSON.stringify({ listingKey, savedAt: Date.now() } satisfies RememberedFiltersOpen));
    } else {
      const raw = store.getItem(FILTERS_OPEN_KEY);
      if (raw && (JSON.parse(raw) as Partial<RememberedFiltersOpen>).listingKey === listingKey) store.removeItem(FILTERS_OPEN_KEY);
    }
  } catch {
    // Storage refused: Back draws the filters folded, as before.
  }
}

/** Whether the filters were left open on this listing, in this document lately. */
export function recallMarketplaceFiltersOpen(listingKey: string): boolean {
  const store = sessionStore();
  if (!store) return false;
  try {
    const entry = JSON.parse(store.getItem(FILTERS_OPEN_KEY) ?? 'null') as Partial<RememberedFiltersOpen> | null;
    return entry?.listingKey === listingKey
      && typeof entry.savedAt === 'number'
      && entry.savedAt >= performance.timeOrigin
      && Date.now() - entry.savedAt <= MARKETPLACE_PAGES_MEMORY_TTL_MS;
  } catch {
    return false;
  }
}

/** A creator has been blocked: their recipes leave every listing this tab keeps. */
export function takeBlockedCreatorOffMarketplacePages(creatorId: string): void {
  const store = sessionStore();
  if (!store) return;
  try {
    for (const key of keptKeys(store)) {
      const entry = readEntry(store, key);
      if (!entry) {
        store.removeItem(key);
        continue;
      }
      const items = entry.items.filter((item) => item.seller?.id !== creatorId);
      if (items.length !== entry.items.length) writeEntry(store, key, { ...entry, items });
    }
  } catch {
    // Storage refused: nothing was kept to give back.
  }
}

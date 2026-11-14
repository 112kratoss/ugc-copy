import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

/**
 * The recipes "Load more recipes" brought to a Marketplace listing, kept for this tab (owner's
 * report, 2026-11-15: Back from a recipe drew the first four alone, so the recipe the reader had
 * opened and their place on the page were gone). Opening a recipe unmounts the listing, so what
 * was loaded after its first page lives only in React state; this keeps it in session storage,
 * one entry per listing address and viewer, and gives it back when the listing is drawn again.
 *
 * Only behind a first page that still starts the same: the first page is always the fresh read,
 * and a listing that has changed at its top is drawn from its first page alone, as it would have
 * been. A memory older than ten minutes is passed over, as the feeds' snapshots are.
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
  firstPageIds: string[];
  savedAt: number;
}

export const MARKETPLACE_PAGES_MEMORY_TTL_MS = 10 * 60_000;
const STORAGE_PREFIX = 'marketplace-pages:';

/** One listing as one viewer sees it: its address, and whose blocks it leaves out. */
export function buildMarketplacePagesKey(listingPath: string, viewerId: string | null): string {
  return `${STORAGE_PREFIX}${viewerId ?? 'visitor'}:${listingPath}`;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Keeps what the listing holds beyond its first page; a listing back at its first page keeps nothing. */
export function rememberMarketplacePages(key: string, firstPage: MarketplacePages, listing: MarketplacePages): void {
  try {
    if (listing.items.length <= firstPage.items.length) {
      window.sessionStorage.removeItem(key);
      return;
    }
    const remembered: RememberedPages = {
      items: listing.items,
      pageInfo: listing.pageInfo,
      firstPageIds: firstPage.items.map((item) => item.id),
      savedAt: Date.now(),
    };
    window.sessionStorage.setItem(key, JSON.stringify(remembered));
  } catch {
    // Storage full or refused: the listing comes back at its first page, as before.
  }
}

/**
 * The listing as it was left, behind the fresh first page; null when nothing was kept for it, the
 * memory is too old, or the first page no longer starts the same.
 */
export function recallMarketplacePages(key: string, firstPage: MarketplacePages): MarketplacePages | null {
  let remembered: RememberedPages | null = null;
  try {
    const raw = window.sessionStorage.getItem(key);
    remembered = raw ? JSON.parse(raw) as RememberedPages : null;
  } catch {
    return null;
  }
  if (!remembered || !Array.isArray(remembered.items) || !Array.isArray(remembered.firstPageIds)) return null;
  if (Date.now() - remembered.savedAt > MARKETPLACE_PAGES_MEMORY_TTL_MS) return null;
  const firstPageIds = firstPage.items.map((item) => item.id);
  if (!sameIds(firstPageIds, remembered.firstPageIds)) return null;

  const onFirstPage = new Set(firstPageIds);
  const later = remembered.items
    .slice(remembered.firstPageIds.length)
    .filter((item) => !onFirstPage.has(item.id));
  return later.length > 0
    ? { items: [...firstPage.items, ...later], pageInfo: remembered.pageInfo }
    : null;
}

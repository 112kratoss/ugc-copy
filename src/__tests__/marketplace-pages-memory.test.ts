import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMarketplacePagesKey,
  MARKETPLACE_PAGES_MEMORY_TTL_MS,
  recallMarketplacePages,
  rememberMarketplacePages,
  type MarketplacePages,
} from '@/app/marketplace/marketplace-pages-memory';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

// What "Load more" brought to a Marketplace listing, kept for the tab so Back from a recipe draws it
// again (the listing's half is marketplace-browser-progressive-render's).

const item = (id: string) => ({ id }) as MarketplaceResourceListItem;

function pages(ids: string[], hasMore: boolean): MarketplacePages {
  return {
    items: ids.map(item),
    pageInfo: { hasMore, nextOffset: hasMore ? ids.length : null, offset: 0, limit: ids.length },
  };
}

const KEY = buildMarketplacePagesKey('/marketplace', null);
const FIRST = pages(['a', 'b'], true);

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('a Marketplace listing kept for the tab', () => {
  it('gives back the later pages behind the fresh first page', () => {
    rememberMarketplacePages(KEY, FIRST, pages(['a', 'b', 'c', 'd'], false));

    // The fresh first page carries its own copies (a price read in the viewer's currency).
    const fresh = { ...FIRST, items: [{ ...item('a'), title: 'fresh' } as MarketplaceResourceListItem, item('b')] };
    const recalled = recallMarketplacePages(KEY, fresh);

    expect(recalled?.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(recalled?.items[0]).toBe(fresh.items[0]);
    expect(recalled?.pageInfo.hasMore).toBe(false);
  });

  it('keeps nothing for a listing at its first page', () => {
    rememberMarketplacePages(KEY, FIRST, pages(['a', 'b', 'c'], true));
    rememberMarketplacePages(KEY, FIRST, FIRST);

    expect(recallMarketplacePages(KEY, FIRST)).toBeNull();
  });

  it('passes over a listing whose first page no longer starts the same', () => {
    rememberMarketplacePages(KEY, FIRST, pages(['a', 'b', 'c'], false));

    expect(recallMarketplacePages(KEY, pages(['new', 'a'], true))).toBeNull();
  });

  it('passes over a listing kept longer than ten minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
    rememberMarketplacePages(KEY, FIRST, pages(['a', 'b', 'c'], false));

    vi.setSystemTime(Date.now() + MARKETPLACE_PAGES_MEMORY_TTL_MS + 1);
    expect(recallMarketplacePages(KEY, FIRST)).toBeNull();
  });

  it('keeps each listing and each viewer apart', () => {
    rememberMarketplacePages(KEY, FIRST, pages(['a', 'b', 'c'], false));

    expect(recallMarketplacePages(buildMarketplacePagesKey('/marketplace?access=free', null), FIRST)).toBeNull();
    expect(recallMarketplacePages(buildMarketplacePagesKey('/marketplace', 'viewer-1'), FIRST)).toBeNull();
  });
});

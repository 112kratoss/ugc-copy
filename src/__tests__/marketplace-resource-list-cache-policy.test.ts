import { describe, expect, it } from 'vitest';

import {
  MARKETPLACE_COMPACT_PAGE_SIZE,
  MARKETPLACE_DEFAULT_PAGE_SIZE,
  MARKETPLACE_INITIAL_PAGE_SIZE,
  shouldCacheMarketplaceResourceListBasePage,
} from '@/lib/marketplace-resource-list-cache-policy';

describe('marketplace resource list cache policy', () => {
  it('caches bounded first pages at every supported page size', () => {
    expect(MARKETPLACE_INITIAL_PAGE_SIZE).toBe(3);
    expect(MARKETPLACE_COMPACT_PAGE_SIZE).toBe(12);
    for (const limit of [
      MARKETPLACE_INITIAL_PAGE_SIZE,
      MARKETPLACE_COMPACT_PAGE_SIZE,
      MARKETPLACE_DEFAULT_PAGE_SIZE,
    ]) {
      expect(shouldCacheMarketplaceResourceListBasePage({ offset: 0, limit })).toBe(true);
    }
  });

  it('caches a tool-filtered first page but never a searched one', () => {
    // F5b: the line between these two is key-space, not correctness. Tool slugs
    // come from the source-tool catalog and arrive normalised, so the number of
    // distinct entries is bounded by that catalog. A free-text query is
    // unbounded, and one visitor could mint arbitrarily many entries.
    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      tool: 'arbitrary-tool',
    })).toBe(true);

    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      query: 'arbitrary search',
    })).toBe(false);

    // A searched *and* tool-filtered page is still uncacheable: the unbounded
    // half decides.
    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
      tool: 'arbitrary-tool',
      query: 'arbitrary search',
    })).toBe(false);
  });

  it('refuses continuation pages, odd page sizes and explicit bypasses', () => {
    for (const options of [
      { offset: MARKETPLACE_INITIAL_PAGE_SIZE, limit: MARKETPLACE_INITIAL_PAGE_SIZE },
      { offset: 0, limit: 48 },
      { offset: 0, limit: MARKETPLACE_INITIAL_PAGE_SIZE, bypassCache: true },
    ]) {
      expect(shouldCacheMarketplaceResourceListBasePage(options)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';

import {
  MARKETPLACE_DEFAULT_PAGE_SIZE,
  MARKETPLACE_INITIAL_PAGE_SIZE,
  shouldCacheMarketplaceResourceListBasePage,
} from '@/lib/marketplace-resource-list-cache-policy';

describe('marketplace resource list cache policy', () => {
  it('caches only bounded, filter-only first pages', () => {
    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: MARKETPLACE_INITIAL_PAGE_SIZE,
    })).toBe(true);
    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: MARKETPLACE_DEFAULT_PAGE_SIZE,
    })).toBe(true);

    for (const options of [
      { offset: MARKETPLACE_INITIAL_PAGE_SIZE, limit: MARKETPLACE_INITIAL_PAGE_SIZE },
      { offset: 0, limit: 48 },
      { offset: 0, limit: MARKETPLACE_INITIAL_PAGE_SIZE, tool: 'arbitrary-tool' },
      { offset: 0, limit: MARKETPLACE_INITIAL_PAGE_SIZE, query: 'arbitrary search' },
      { offset: 0, limit: MARKETPLACE_INITIAL_PAGE_SIZE, bypassCache: true },
    ]) {
      expect(shouldCacheMarketplaceResourceListBasePage(options)).toBe(false);
    }
  });
});

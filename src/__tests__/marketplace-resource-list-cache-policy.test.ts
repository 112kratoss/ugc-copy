import { describe, expect, it } from 'vitest';

import { shouldCacheMarketplaceResourceListBasePage } from '@/lib/marketplace-resource-list-cache-policy';

describe('marketplace resource list cache policy', () => {
  it('caches only bounded, filter-only first pages', () => {
    expect(shouldCacheMarketplaceResourceListBasePage({
      offset: 0,
      limit: 24,
    })).toBe(true);

    for (const options of [
      { offset: 24, limit: 24 },
      { offset: 0, limit: 48 },
      { offset: 0, limit: 24, tool: 'arbitrary-tool' },
      { offset: 0, limit: 24, query: 'arbitrary search' },
      { offset: 0, limit: 24, bypassCache: true },
    ]) {
      expect(shouldCacheMarketplaceResourceListBasePage(options)).toBe(false);
    }
  });
});

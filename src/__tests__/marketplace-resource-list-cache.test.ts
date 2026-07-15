import { describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidateTag: cacheMocks.revalidateTag,
}));

import {
  invalidateMarketplaceResourceListCache,
  MARKETPLACE_RESOURCE_LIST_CACHE_TAG,
} from '@/lib/marketplace-resource-list-cache';

describe('marketplace resource list cache', () => {
  it('expires the shared marketplace tag immediately', () => {
    invalidateMarketplaceResourceListCache();

    expect(cacheMocks.revalidateTag).toHaveBeenCalledWith(
      MARKETPLACE_RESOURCE_LIST_CACHE_TAG,
      { expire: 0 },
    );
  });
});

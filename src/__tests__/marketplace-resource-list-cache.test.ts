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
  // A sale or a free unlock moves counts and removes nothing: the storefront
  // is answered from the cache once more while it is read again behind it.
  it('refreshes the shared marketplace tag in the background', () => {
    invalidateMarketplaceResourceListCache();

    expect(cacheMocks.revalidateTag.mock.calls).toEqual([
      [MARKETPLACE_RESOURCE_LIST_CACHE_TAG, 'max'],
    ]);
  });
});

import 'server-only';

import { revalidateTag } from 'next/cache';

export const MARKETPLACE_RESOURCE_LIST_CACHE_TAG = 'marketplace-resource-list:v1';

export function invalidateMarketplaceResourceListCache() {
  revalidateTag(MARKETPLACE_RESOURCE_LIST_CACHE_TAG, { expire: 0 });
}

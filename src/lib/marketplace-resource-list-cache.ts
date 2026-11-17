import 'server-only';

import { revalidateTag } from 'next/cache';

/**
 * The storefront's tag: the `/marketplace` page and the listing API's first
 * pages (`getCachedMarketplaceResourceListBase`, which carries the feed's tag
 * too, so a removal expires it at once). Refreshed in the background only
 * (`'max'`), never expired at once: see `PUBLIC_PAGE_CACHE_TAG` for why a tag
 * keeps one profile.
 */
export const MARKETPLACE_RESOURCE_LIST_CACHE_TAG = 'marketplace-resource-list:v1';

/**
 * A sale or a free unlock: the storefront's counts move. The page and the
 * listing are answered from the cache once more while they are read again
 * behind that request; nothing is removed, so nobody waits for a cold read.
 */
export function invalidateMarketplaceResourceListCache() {
  revalidateTag(MARKETPLACE_RESOURCE_LIST_CACHE_TAG, 'max');
}

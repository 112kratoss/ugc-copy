import 'server-only';

import { revalidateTag } from 'next/cache';

export const SHOWCASE_FEED_CACHE_TAG = 'showcase-feed:v2';

export function invalidateShowcaseFeedCache() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
}

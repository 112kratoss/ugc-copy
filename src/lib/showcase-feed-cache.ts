import 'server-only';

import { revalidateTag } from 'next/cache';

import { PUBLIC_PAGE_CACHE_TAG } from '@/lib/public-page-cache';

export const SHOWCASE_FEED_CACHE_TAG = 'showcase-feed:v3';

/**
 * A change the feeds and the cached public pages both show: a publish, an
 * edit, a visibility change, an archive or delete, a profile edit, an account
 * deletion, a moderation decision, the hourly feed maintenance (its totals and
 * account labels), a repaired preview.
 */
export function invalidateShowcaseFeedCache() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
  revalidateTag(PUBLIC_PAGE_CACHE_TAG, { expire: 0 });
}

/**
 * A change only the feeds show: a block or a report. The public pages are
 * drawn for no one (a block is applied in the browser), and a report hides
 * nothing until a moderator decides, so every cached page is left as it is.
 */
export function invalidateShowcaseFeedCacheOnly() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
}

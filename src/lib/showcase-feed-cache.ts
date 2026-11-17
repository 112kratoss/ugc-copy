import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidateTag } from 'next/cache';

import { logBackendError } from '@/lib/backend-logger';
import { MARKETPLACE_RESOURCE_LIST_CACHE_TAG } from '@/lib/marketplace-resource-list-cache';
import {
  PUBLIC_PAGE_CACHE_TAG,
  PUBLIC_PAGE_REFRESH_TAG,
  publicCreatorHandleTag,
  publicCreatorPageTag,
  publicPostArrivalTag,
  publicPostPageTag,
} from '@/lib/public-page-cache';

export const SHOWCASE_FEED_CACHE_TAG = 'showcase-feed:v3';

/**
 * What a write does to the cached feeds and public pages comes in four kinds,
 * one helper each, and `public-page-invalidation-classes.test.ts` lists every
 * file that uses one:
 *
 * - a removal, `invalidateShowcaseFeedCache`: the feeds and every public page
 *   at once;
 * - a change to one post that leaves it in view or brings it in,
 *   `invalidateShowcaseFeedAndRefreshPostPages`: the feeds at once, and the
 *   pages that draw the post in the background;
 * - a change whose pages cannot be named (a profile, a repaired preview),
 *   `invalidateShowcaseFeedAndRefreshEveryPage`: the feeds at once, and every
 *   public page in the background;
 * - a change only the feeds show, `invalidateShowcaseFeedCacheOnly`.
 *
 * The feeds must show a new post at once, so their tag is always expired with
 * `{ expire: 0 }`. A page refreshed in the background (`'max'`) is answered
 * from the cache once more, in its previous version, while it is drawn again
 * behind that visitor: nobody waits for a cold render because of a change that
 * removes nothing. A sale or a free unlock refreshes the storefront alone
 * (`invalidateMarketplaceResourceListCache`).
 */

/**
 * A removal: a post or a creation deleted, a post moved to private or out of
 * the lists (public to unlisted), archived, covered as mature content, taken
 * down or hidden by a moderator, an account deleted. The feeds and every
 * cached public page are expired at once, so nothing removed is shown again
 * from a cache: the next visitor of each page waits for it to be drawn. Also
 * the operator's lever (`/api/cron/showcase-feed-invalidate`).
 */
export function invalidateShowcaseFeedCache() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
  revalidateTag(PUBLIC_PAGE_CACHE_TAG, { expire: 0 });
}

/**
 * A change only the feeds show: a block or a report, and the hourly feed
 * maintenance (its rankings, totals and account labels are read by the feeds
 * alone). The public pages are drawn for no one (a block is applied in the
 * browser), and a report hides nothing until a moderator decides, so every
 * cached page is left as it is.
 */
export function invalidateShowcaseFeedCacheOnly() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
}

export type PublicPostPageChange = {
  postId: string;
  /** The post's creation, whose id is a legacy address of the post's page. */
  generationId?: string | null;
  /** The post's creator, whose page lists it. */
  creatorId: string;
  /**
   * The post came into view with this change (published, made public or
   * unlisted while it was private, restored from the archive or by a
   * moderator): its page could only hold a not-found until now, and it is
   * dropped at once rather than served stale.
   */
  arrived: boolean;
  /** Made by this change: no post can credit it as the one it remixed yet. */
  isNew?: boolean;
};

/** Past this many remixes, a post's change refreshes every page rather than naming theirs. */
export const REMIX_PAGE_REFRESH_LIMIT = 50;
const REMIX_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * The posts whose remix credit names this one (`posts.remix_parent_post_id`):
 * their pages and their creators' pages draw its title and whether it is
 * open. Null when they could not be read or are too many to name.
 */
async function loadRemixesCrediting(
  adminSupabase: SupabaseClient,
  postId: string,
): Promise<Array<{ id: string; userId: string | null }> | null> {
  try {
    const { data, error } = await adminSupabase
      .from('posts')
      .select('id, user_id')
      .eq('remix_parent_post_id', postId)
      .limit(REMIX_PAGE_REFRESH_LIMIT + 1)
      .abortSignal(AbortSignal.timeout(REMIX_LOOKUP_TIMEOUT_MS));
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id?: unknown; user_id?: unknown }>;
    if (rows.length > REMIX_PAGE_REFRESH_LIMIT) return null;
    return rows.flatMap((row) => (typeof row.id === 'string'
      ? [{ id: row.id, userId: typeof row.user_id === 'string' ? row.user_id : null }]
      : []));
  } catch (error) {
    logBackendError('public_page_remix_refresh_lookup_failed', { error });
    return null;
  }
}

/**
 * A change to one post that removes nothing from view: a publish, an edit, a
 * move to public or unlisted from private, a restore. The feeds are expired
 * at once; in the background, the post's own page (and its legacy address),
 * its creator's page, the storefront (which lists a recipe with its post),
 * and the pages that draw the post in a remix credit: each remix's page and
 * its creator's. A post that has just come into view also has its not-found
 * page dropped at once. When the remixes cannot be named, every public page
 * is refreshed in the background instead.
 *
 * Never throws for the remix lookup: a failed one refreshes every page.
 */
export async function invalidateShowcaseFeedAndRefreshPostPages(
  adminSupabase: SupabaseClient,
  change: PublicPostPageChange,
): Promise<void> {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });

  const pageIds = [change.postId, change.generationId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  for (const id of pageIds) revalidateTag(publicPostPageTag(id), 'max');
  if (change.arrived) {
    for (const id of pageIds) revalidateTag(publicPostArrivalTag(id), { expire: 0 });
  }
  revalidateTag(publicCreatorPageTag(change.creatorId), 'max');
  revalidateTag(MARKETPLACE_RESOURCE_LIST_CACHE_TAG, 'max');

  if (change.isNew) return;
  const remixes = await loadRemixesCrediting(adminSupabase, change.postId);
  if (!remixes) {
    revalidateTag(PUBLIC_PAGE_REFRESH_TAG, 'max');
    return;
  }
  for (const remix of remixes) {
    revalidateTag(publicPostPageTag(remix.id), 'max');
    if (remix.userId) revalidateTag(publicCreatorPageTag(remix.userId), 'max');
  }
}

/**
 * A change whose pages cannot be named: a profile saved (its name, handle and
 * picture are on the creator's page, every post page of theirs, each remix
 * credit that names them and the storefront's cards) or a repaired preview
 * (the sweep knows the media, not every page that draws it). The feeds are
 * expired at once, every public page is refreshed in the background, and a
 * page that could only hold a not-found until now is dropped at once: a post
 * a moderator brought back, a handle a profile has just taken.
 */
export function invalidateShowcaseFeedAndRefreshEveryPage(arrivals: {
  postIds?: readonly string[];
  handles?: readonly string[];
} = {}) {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
  revalidateTag(PUBLIC_PAGE_REFRESH_TAG, 'max');
  for (const postId of arrivals.postIds ?? []) {
    revalidateTag(publicPostArrivalTag(postId), { expire: 0 });
  }
  for (const handle of arrivals.handles ?? []) {
    const tag = publicCreatorHandleTag(handle);
    if (tag) revalidateTag(tag, { expire: 0 });
  }
}

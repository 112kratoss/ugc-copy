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
 * The feeds' cached reads again, refreshed in the background (`'max'` only):
 * for every change that takes nothing out of view (a publish, an edit, a
 * restore, a profile saved, a repaired preview) and for the hourly
 * maintenance, whose totals reorder the feeds and whose account labels and
 * negative-feedback rates can drop a post from recommendations (they already
 * take the hour to be computed). Take-downs, a post's own cover and media
 * deleted from under a card go through `SHOWCASE_FEED_CACHE_TAG` instead. Each
 * cached feed read carries both tags, and removals keep expiring the other one
 * at once; a tag is only ever invalidated one way (`PUBLIC_PAGE_CACHE_TAG`
 * says why).
 */
export const SHOWCASE_FEED_REFRESH_TAG = 'showcase-feed:refresh:v1';

/**
 * What a write does to the cached feeds and public pages comes in five kinds,
 * one helper each, and `public-page-invalidation-classes.test.ts` lists every
 * file that uses one:
 *
 * - a removal, `invalidateShowcaseFeedCache`: the feeds and every public page
 *   at once;
 * - a change to one post that leaves it in view or brings it in,
 *   `invalidateShowcaseFeedAndRefreshPostPages`: the feeds and the pages that
 *   draw the post in the background;
 * - a change whose pages cannot be named (a profile, a repaired preview),
 *   `invalidateShowcaseFeedAndRefreshEveryPage`: the feeds and every public
 *   page in the background;
 * - a change only the feeds show (a block, a report),
 *   `invalidateShowcaseFeedCacheOnly`: the feeds at once;
 * - the feeds' hourly maintenance, `refreshShowcaseFeedsInBackground`.
 *
 * A cache refreshed in the background (`'max'`) is answered once more, in its
 * previous version, while it is drawn again behind that visitor: nobody waits
 * for a cold render because of a change that removes nothing. So a new post
 * may reach the signed-out `/`, Explore's shared first pages and the shelf one
 * visit late (its own page, where the composers land, drops its not-found at
 * once); anything that takes content out of view still expires at once, as
 * does a change that deleted media a feed card draws (`mediaRemoved`) or
 * edited words one draws (`feedTextChanged`): only new posts, restores and
 * media-only edits reach the feeds late. A sale
 * or a free unlock refreshes the storefront alone
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
 * A change only the feeds show: a block or a report. The public pages are
 * drawn for no one (a block is applied in the browser), and a report hides
 * nothing until a moderator decides, so every cached page is left as it is.
 * The hourly maintenance refreshes the feeds in the background instead
 * (`refreshShowcaseFeedsInBackground`).
 */
export function invalidateShowcaseFeedCacheOnly() {
  revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
}

/**
 * The hourly feed maintenance: its totals reorder the feeds, and its labels and
 * negative-feedback rates can drop a post from recommendations, which they
 * already take the hour to compute; none of it is a removal. Expiring them at once made the next visitor of `/` and Explore wait
 * for a cold render every hour, about 3 s on a phone (speed baseline,
 * 2026-11-19: HTML at 3,354 ms, LCP 3,976 ms, against 493 / 934 ms warm). In
 * the background, that visitor is answered from the cache while the feeds are
 * drawn again behind them.
 */
export function refreshShowcaseFeedsInBackground() {
  revalidateTag(SHOWCASE_FEED_REFRESH_TAG, 'max');
}

/**
 * The feeds after a change that takes nothing out of view: in the background,
 * the next visitor of `/` and Explore answered from the cache while they are
 * drawn again (a publish made `/` cold for about 3 s on a phone, speed
 * remeasure 2026-11-24). Unless the change deleted media a card draws, or
 * edited words a card draws (a title, a prompt, a price, a creator's name or
 * handle): then at once, so no cached card points at a file that is gone or
 * shows words its creator took out (review of #918; a `'max'` refresh that
 * keeps failing would serve them for as long as it fails).
 */
function refreshShowcaseFeeds({ mediaRemoved, feedTextChanged }: { mediaRemoved?: boolean; feedTextChanged?: boolean }) {
  if (mediaRemoved || feedTextChanged) {
    revalidateTag(SHOWCASE_FEED_CACHE_TAG, { expire: 0 });
    return;
  }
  revalidateTag(SHOWCASE_FEED_REFRESH_TAG, 'max');
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
  /**
   * The change deleted media the post's page drew (a picture or clip replaced
   * or taken out, its files removed at once): the page is drawn again at once,
   * through the same tag as an arrival, rather than served once with media
   * that is gone, and so are the feeds. The cards on its creator's page and
   * the storefront are still refreshed in the background, so they may show
   * the old cover once.
   */
  mediaRemoved?: boolean;
  /** Made by this change: no post can credit it as the one it remixed yet. */
  isNew?: boolean;
  /**
   * The change edited words a cached feed card draws while the post was
   * listed (`editChangesFeedText`): the feeds are drawn again at once. A post
   * that comes into view with the change has no card to correct.
   */
  feedTextChanged?: boolean;
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
 * move to public or unlisted from private, a restore. In the background, the
 * feeds (at once instead when the change deleted media their cards draw,
 * `mediaRemoved`), the post's own page (and its legacy address),
 * its creator's page, the storefront (which lists a recipe with its post),
 * and the pages that draw the post in a remix credit: each remix's page and
 * its creator's. A post that has just come into view also has its not-found
 * page dropped at once, as has a post whose edit deleted media its page drew.
 * When the remixes cannot be named, every public page is refreshed in the
 * background instead.
 *
 * Never throws for the remix lookup: a failed one refreshes every page.
 */
export async function invalidateShowcaseFeedAndRefreshPostPages(
  adminSupabase: SupabaseClient,
  change: PublicPostPageChange,
): Promise<void> {
  refreshShowcaseFeeds({ mediaRemoved: change.mediaRemoved, feedTextChanged: change.feedTextChanged });

  const pageIds = [change.postId, change.generationId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  for (const id of pageIds) revalidateTag(publicPostPageTag(id), 'max');
  if (change.arrived || change.mediaRemoved) {
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
 * (the sweep knows the media, not every page that draws it). The feeds, the
 * storefront and every public page are refreshed in the background, and a
 * page that could only hold a not-found until now is dropped at once: a post
 * a moderator brought back, a handle a profile has just taken. A change that
 * took media out (`mediaRemoved`: a profile photo replaced, its old file
 * deleted, or taken off, or a poster regenerated, its old public copy pruned)
 * or changed a creator's name or handle (`feedTextChanged`) expires the feeds
 * at once, as their cards draw it.
 */
export function invalidateShowcaseFeedAndRefreshEveryPage(arrivals: {
  postIds?: readonly string[];
  handles?: readonly string[];
  mediaRemoved?: boolean;
  /** A creator's display name or handle changed: every card of theirs draws it. */
  feedTextChanged?: boolean;
} = {}) {
  refreshShowcaseFeeds({ mediaRemoved: arrivals.mediaRemoved, feedTextChanged: arrivals.feedTextChanged });
  revalidateTag(PUBLIC_PAGE_REFRESH_TAG, 'max');
  // The storefront's first pages carry the feed tag alone of the two, which
  // this no longer expires (the post-pages refresh names the storefront too).
  revalidateTag(MARKETPLACE_RESOURCE_LIST_CACHE_TAG, 'max');
  for (const postId of arrivals.postIds ?? []) {
    revalidateTag(publicPostArrivalTag(postId), { expire: 0 });
  }
  for (const handle of arrivals.handles ?? []) {
    const tag = publicCreatorHandleTag(handle);
    if (tag) revalidateTag(tag, { expire: 0 });
  }
}

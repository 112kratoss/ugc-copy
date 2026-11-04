import 'server-only';

import { unstable_cache } from 'next/cache';

import { logBackendError } from '@/lib/backend-logger';
import { readHomeFeed } from '@/lib/home-dashboard-service';
import type { HomeShelfItem } from '@/lib/home-shelf';
import { loadHomeShelfForApi, withoutPost } from '@/lib/home-shelf-server';
import { getFeedChip } from '@/lib/post-feed-chips';
import type { ShowcaseFeedPage } from '@/lib/showcase';
import { SHOWCASE_FEED_CACHE_TAG } from '@/lib/showcase-feed-cache';

/**
 * The reads of the signed-out `/` (`AnonymousHome`), cached for as long as the
 * page itself.
 *
 * Next rebuilds a prerendered page at the shortest `revalidate` that any
 * cached read made during its render reports, the page's own export included,
 * and a cached read made inside another one reports nothing. The feed's own
 * cache keeps a page for 60 seconds and the shelf's for 5 minutes (they serve
 * the API and the app too), so read directly they held `/` to a one-minute
 * window whatever `src/app/page.tsx` said: Sentry's uptime check then rebuilt
 * it about once a minute. Read through the two caches below, the page keeps
 * its own window.
 *
 * Both carry the feed's tag, which also puts it on the page: a publish, edit,
 * delete, take-down, profile edit or repaired poster (`invalidateShowcaseFeedCache`),
 * and the hourly feed maintenance, rebuild `/` at its next visit rather than
 * at the end of the window. What no tag covers waits for the window: likes,
 * comment counts and the For you order between those events, and what a
 * catalog release or the welcome-credit amount changes (the "What's new"
 * models card, a shelf card's credit price and its "Free to try").
 */

/**
 * How long the signed-out `/` is reused between rebuilds: its `revalidate`,
 * which `src/app/page.tsx` must state as a literal (a test holds the two
 * equal). Fifteen minutes: at most 96 rebuilds a day beside the invalidations,
 * against about 1,250 at one minute, and the bound on everything no tag
 * reaches (counts, catalog changes, a take-down whose invalidation failed).
 * It also keeps a page 45 minutes clear of the hour a poster-less post's
 * signed private preview lasts (`resolveOwnedStoredMediaUrl`).
 */
export const ANONYMOUS_HOME_REVALIDATE_SECONDS = 900;

/** How soon a signed-out home built without its feed or its shelf is rebuilt. */
export const ANONYMOUS_HOME_RETRY_SECONDS = 60;

/**
 * The deployment this server is, falling back to its release where Vercel
 * names none. Part of every key here: the Data Cache outlives a deploy, and a
 * deployment, even a configuration-only one of the same commit, must not
 * build `/` from an entry another one wrote, whatever shape that one
 * gave a card and however old its signed links are.
 */
function currentDeployment(): string {
  return process.env.VERCEL_DEPLOYMENT_ID?.trim()
    || process.env.RELEASE_GIT_SHA?.trim()
    || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.VERCEL_URL?.trim()
    || 'dev';
}

const SIGNED_OUT = { viewerUserId: null, isAnonymous: false } as const;

const readCachedAnonymousHomeFeed = unstable_cache(
  () => readHomeFeed({ viewerUserId: null, chip: getFeedChip(undefined) }),
  ['anonymous-home-feed-v1', currentDeployment()],
  { revalidate: ANONYMOUS_HOME_REVALIDATE_SECONDS, tags: [SHOWCASE_FEED_CACHE_TAG] },
);

const readCachedAnonymousHomeShelf = unstable_cache(
  async (): Promise<HomeShelfItem[]> => {
    // The throwing read, so a failure is never kept for the window.
    const items = await loadHomeShelfForApi(SIGNED_OUT);
    return items.map((item) => (item.kind === 'creation' ? withoutPost(item) : item));
  },
  ['anonymous-home-shelf-v1', currentDeployment()],
  { revalidate: ANONYMOUS_HOME_REVALIDATE_SECONDS, tags: [SHOWCASE_FEED_CACHE_TAG] },
);

/**
 * Holds nothing. Read by a render that could not read a section, it reports a
 * one-minute `revalidate`, which Next keeps as that page's window (see the
 * top of this file), so a home built without its feed is rebuilt a minute
 * later, not a whole window later.
 */
const readRetryWindowMarker = unstable_cache(
  async () => true,
  ['anonymous-home-retry-window-v1'],
  { revalidate: ANONYMOUS_HOME_RETRY_SECONDS },
);

async function retryAnonymousHomeSoon() {
  try {
    await readRetryWindowMarker();
  } catch {
    // Outside a render there is no window to shorten.
  }
}

/**
 * Page one of the For you lane as a signed-out visitor sees it, or null when
 * it cannot be read: the page then hands the lane to the client.
 */
export async function loadAnonymousHomeFeed(): Promise<ShowcaseFeedPage | null> {
  try {
    return await readCachedAnonymousHomeFeed();
  } catch (error) {
    logBackendError('home_dashboard_feed_load_failed', { error });
    await retryAnonymousHomeSoon();
    return null;
  }
}

/** The "Make this" shelf as a signed-out visitor sees it, or none when it cannot be read. */
export async function loadAnonymousHomeShelf(): Promise<HomeShelfItem[]> {
  try {
    return await readCachedAnonymousHomeShelf();
  } catch (error) {
    logBackendError('anonymous_home_shelf_load_failed', { error });
    await retryAnonymousHomeSoon();
    return [];
  }
}

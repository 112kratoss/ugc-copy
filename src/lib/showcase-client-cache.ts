'use client';

import type {
  ShowcaseCategory,
  ShowcaseFeedPage,
  ShowcaseResourceFilter,
  ShowcaseSort,
  ShowcaseUnlockFilter,
} from '@/lib/showcase';

// v2 added `surface` to the key. The home feed and the showcase grid both cache
// here and their filter tuples overlap, so without it a home-feed snapshot could
// be restored into the showcase grid and vice versa.
const SHOWCASE_CLIENT_CACHE_VERSION = 'v2';
const SHOWCASE_CLIENT_CACHE_STORAGE_PREFIX = `magicbooklet:showcase:${SHOWCASE_CLIENT_CACHE_VERSION}:`;
const SHOWCASE_CLIENT_CACHE_TTL_MS = 10 * 60 * 1_000;
const SHOWCASE_CLIENT_CACHE_MAX_ENTRIES = 8;
export const SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS = 36;

/** Which paginated surface a snapshot belongs to. */
export type ShowcaseClientCacheSurface = 'showcase' | 'home-feed';

export interface ShowcaseClientCacheKeyInput {
  surface?: ShowcaseClientCacheSurface;
  viewerId?: string | null;
  category: ShowcaseCategory;
  sort: ShowcaseSort;
  tool: string | null;
  unlock: ShowcaseUnlockFilter;
  resource: ShowcaseResourceFilter;
}

export interface ShowcaseClientSnapshot {
  feed: ShowcaseFeedPage;
  renderedItemCount: number;
  savedItemIds: string[];
  cachedAt: number;
}

const memoryCache = new Map<string, ShowcaseClientSnapshot>();

/**
 * Creators blocked in this tab since it loaded. Explore draws its first rows
 * from a page the server builds for everyone, and merges the viewer's own feed
 * in under the rows already drawn: a creator blocked on another page (their
 * own, or from saved posts) would be on screen again the moment the viewer
 * arrives. Kept in memory, which lasts for the move from that page to this one.
 */
const creatorsBlockedThisVisit = new Set<string>();

/**
 * The viewer's own Hide and Not interested, as far as the server has told this
 * tab (`/api/showcase/viewer-exclusions`). The server leaves them out of For
 * you, and Explore's first page is not the viewer's own. Kept with the blocks
 * above so that coming back to Explore within the tab does not draw them
 * again while the same answer is fetched a second time.
 */
const creatorsHiddenThisVisit = new Set<string>();
const postsHiddenThisVisit = new Set<string>();

/**
 * Whose blocks and preferences this tab is remembering. Signing out, or in as
 * someone else, does not reload the page, so what is remembered carries its
 * viewer as a snapshot's key does: a page reads it only for that viewer, and
 * `claimVisitMemoryFor` starts it again once another viewer, or nobody, is
 * looking. `undefined` until a page that knows who is looking has said so:
 * what was learned before then is a signed-in viewer's (only they can block),
 * so the first signed-in page to ask takes it as its own, and a signed-out one
 * is shown none of it.
 */
let visitViewerId: string | null | undefined;
const NOBODY: ReadonlySet<string> = new Set<string>();

function isVisitMemoryOf(viewerId: string | null): boolean {
  return visitViewerId === undefined ? viewerId !== null : visitViewerId === viewerId;
}

/** A page that knows who is looking says so. What was remembered for anyone else is dropped. */
export function claimVisitMemoryFor(viewerId: string | null) {
  if (!isVisitMemoryOf(viewerId)) {
    creatorsBlockedThisVisit.clear();
    creatorsHiddenThisVisit.clear();
    postsHiddenThisVisit.clear();
  }
  visitViewerId = viewerId;
}

export function getCreatorsBlockedThisVisit(viewerId: string | null): ReadonlySet<string> {
  return isVisitMemoryOf(viewerId) ? creatorsBlockedThisVisit : NOBODY;
}

export function getFeedPreferencesHiddenThisVisit(viewerId: string | null): {
  creatorIds: ReadonlySet<string>;
  postIds: ReadonlySet<string>;
} {
  return isVisitMemoryOf(viewerId)
    ? { creatorIds: creatorsHiddenThisVisit, postIds: postsHiddenThisVisit }
    : { creatorIds: NOBODY, postIds: NOBODY };
}

/** Keeps the server's answer to one viewer about the posts a page asked about, for the rest of their visit. */
export function rememberViewerExclusionsForVisit(viewerId: string, exclusions: {
  blockedCreatorIds: string[];
  hiddenCreatorIds: string[];
  hiddenPostIds: string[];
}) {
  claimVisitMemoryFor(viewerId);
  exclusions.blockedCreatorIds.forEach((id) => creatorsBlockedThisVisit.add(id));
  exclusions.hiddenCreatorIds.forEach((id) => creatorsHiddenThisVisit.add(id));
  exclusions.hiddenPostIds.forEach((id) => postsHiddenThisVisit.add(id));
}

/** A creator has been unblocked: their posts may be drawn again. */
export function forgetBlockedCreatorForVisit(creatorId: string) {
  creatorsBlockedThisVisit.delete(creatorId);
}

/**
 * A feed page without the posts this tab already knows this viewer's own feed
 * leaves out: a blocked creator's on every lane, and on For you what the
 * viewer hid or marked not interested. The same list back when it knows of
 * nothing, which is every visit of nearly every viewer, and for anyone but the
 * viewer it learned them for.
 */
export function filterFeedItemsForVisit<TItem extends { id: string; creator: { id?: string | null } }>(
  items: TItem[],
  { forYou, viewerId }: { forYou: boolean; viewerId: string | null },
): TItem[] {
  if (!isVisitMemoryOf(viewerId)) {
    return items;
  }

  const usesPreferences = forYou && (creatorsHiddenThisVisit.size > 0 || postsHiddenThisVisit.size > 0);
  if (creatorsBlockedThisVisit.size === 0 && !usesPreferences) {
    return items;
  }

  return items.filter((item) => {
    const creatorId = item.creator.id;
    if (creatorId && creatorsBlockedThisVisit.has(creatorId)) return false;
    if (!usesPreferences) return true;
    return !postsHiddenThisVisit.has(item.id) && !(creatorId && creatorsHiddenThisVisit.has(creatorId));
  });
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getStorageKey(cacheKey: string) {
  return `${SHOWCASE_CLIENT_CACHE_STORAGE_PREFIX}${cacheKey}`;
}

function isShowcaseClientSnapshot(value: unknown): value is ShowcaseClientSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ShowcaseClientSnapshot>;
  return Boolean(
    candidate.feed
    && Array.isArray(candidate.feed.items)
    && candidate.feed.pageInfo
    && typeof candidate.renderedItemCount === 'number'
    && Array.isArray(candidate.savedItemIds)
    && typeof candidate.cachedAt === 'number'
  );
}

function removeSnapshot(cacheKey: string) {
  memoryCache.delete(cacheKey);
  getSessionStorage()?.removeItem(getStorageKey(cacheKey));
}

function pruneMemoryCache() {
  if (memoryCache.size <= SHOWCASE_CLIENT_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestEntries = [...memoryCache.entries()]
    .sort((left, right) => left[1].cachedAt - right[1].cachedAt)
    .slice(0, memoryCache.size - SHOWCASE_CLIENT_CACHE_MAX_ENTRIES);
  oldestEntries.forEach(([cacheKey]) => removeSnapshot(cacheKey));
}

export function buildShowcaseClientCacheKey(input: ShowcaseClientCacheKeyInput): string {
  return [
    input.surface ?? 'showcase',
    input.viewerId?.trim() || 'anonymous',
    input.category,
    input.sort,
    input.tool?.trim() || 'all',
    input.unlock,
    input.resource,
  ].map((value) => encodeURIComponent(value)).join(':');
}

export function readShowcaseClientSnapshot(
  cacheKey: string,
  now = Date.now()
): ShowcaseClientSnapshot | null {
  let snapshot = memoryCache.get(cacheKey) ?? null;

  if (!snapshot) {
    const storage = getSessionStorage();
    const serialized = storage?.getItem(getStorageKey(cacheKey));
    if (serialized) {
      try {
        const parsed = JSON.parse(serialized) as unknown;
        if (isShowcaseClientSnapshot(parsed)) {
          snapshot = parsed;
          memoryCache.set(cacheKey, snapshot);
        } else {
          storage?.removeItem(getStorageKey(cacheKey));
        }
      } catch {
        storage?.removeItem(getStorageKey(cacheKey));
      }
    }
  }

  if (!snapshot) {
    return null;
  }

  if (now - snapshot.cachedAt > SHOWCASE_CLIENT_CACHE_TTL_MS) {
    removeSnapshot(cacheKey);
    return null;
  }

  return snapshot;
}

export function writeShowcaseClientSnapshot(
  cacheKey: string,
  snapshot: Omit<ShowcaseClientSnapshot, 'cachedAt'>,
  now = Date.now()
): ShowcaseClientSnapshot {
  const isPureOffsetSnapshot = snapshot.feed.pageInfo.nextCursor == null
    && typeof snapshot.feed.pageInfo.nextOffset === 'number';
  const boundedSnapshot = isPureOffsetSnapshot
    && snapshot.feed.items.length > SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS
    ? {
        ...snapshot,
        feed: {
          ...snapshot.feed,
          items: snapshot.feed.items.slice(0, SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS),
          pageInfo: {
            ...snapshot.feed.pageInfo,
            hasMore: true,
            nextOffset: SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS,
          },
        },
        renderedItemCount: Math.min(
          snapshot.renderedItemCount,
          SHOWCASE_SNAPSHOT_MAX_OFFSET_ITEMS
        ),
      }
    : snapshot;
  const nextSnapshot: ShowcaseClientSnapshot = {
    ...boundedSnapshot,
    cachedAt: now,
  };

  memoryCache.set(cacheKey, nextSnapshot);
  pruneMemoryCache();

  try {
    getSessionStorage()?.setItem(getStorageKey(cacheKey), JSON.stringify(nextSnapshot));
  } catch {
    // The in-memory cache still preserves route-to-route navigation when a
    // browser blocks storage or the tab's storage quota is exhausted.
  }

  return nextSnapshot;
}

/**
 * A creator has been blocked: remembers them for the visit (above), and takes
 * their posts out of every snapshot this tab keeps, the grid's and the home
 * feed's, for every viewer and filter. A creator can be blocked away from the
 * pages that keep a snapshot (on their own page, from saved posts), and a
 * snapshot restored afterwards would bring their posts back for as long as it
 * stays fresh. A snapshot keeps its age and its place.
 */
export function takeBlockedCreatorOffClientFeeds(creatorId: string) {
  // Only a signed-in viewer can block. If the last page to say who was looking
  // was a signed-out one, someone has signed in since: the next signed-in page
  // to ask takes this as its own.
  if (visitViewerId === null) visitViewerId = undefined;
  creatorsBlockedThisVisit.add(creatorId);
  const storage = getSessionStorage();
  const cacheKeys = new Set(memoryCache.keys());
  if (storage) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SHOWCASE_CLIENT_CACHE_STORAGE_PREFIX)) {
        cacheKeys.add(key.slice(SHOWCASE_CLIENT_CACHE_STORAGE_PREFIX.length));
      }
    }
  }

  for (const cacheKey of cacheKeys) {
    // Reading also drops a snapshot that has gone stale or cannot be read.
    const snapshot = readShowcaseClientSnapshot(cacheKey);
    if (!snapshot) {
      continue;
    }

    const items = snapshot.feed.items.filter((item) => item.creator?.id !== creatorId);
    if (items.length === snapshot.feed.items.length) {
      continue;
    }

    const nextSnapshot: ShowcaseClientSnapshot = {
      ...snapshot,
      feed: { ...snapshot.feed, items },
      renderedItemCount: Math.min(snapshot.renderedItemCount, items.length),
    };
    memoryCache.set(cacheKey, nextSnapshot);
    try {
      storage?.setItem(getStorageKey(cacheKey), JSON.stringify(nextSnapshot));
    } catch {
      // As when a snapshot is written: the copy in memory still holds.
    }
  }
}

export function hasFreshShowcaseClientSnapshot(cacheKey: string): boolean {
  return readShowcaseClientSnapshot(cacheKey) !== null;
}

/** Test helper: drops the copies kept in memory, and leaves what the tab remembers of the viewer. */
export function forgetShowcaseSnapshotsInMemoryForTests() {
  memoryCache.clear();
}

export function clearShowcaseClientCacheForTests() {
  memoryCache.clear();
  creatorsBlockedThisVisit.clear();
  creatorsHiddenThisVisit.clear();
  postsHiddenThisVisit.clear();
  visitViewerId = undefined;
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(SHOWCASE_CLIENT_CACHE_STORAGE_PREFIX)) {
      storage.removeItem(key);
    }
  }
}

export { SHOWCASE_CLIENT_CACHE_TTL_MS };

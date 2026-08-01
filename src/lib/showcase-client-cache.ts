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
  const nextSnapshot: ShowcaseClientSnapshot = {
    ...snapshot,
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

export function hasFreshShowcaseClientSnapshot(cacheKey: string): boolean {
  return readShowcaseClientSnapshot(cacheKey) !== null;
}

export function clearShowcaseClientCacheForTests() {
  memoryCache.clear();
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

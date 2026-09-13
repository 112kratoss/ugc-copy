import AsyncStorage from '@react-native-async-storage/async-storage';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { HOME_FEED_CHIPS, type HomeFeedChipId } from './home-feed-view-model';
import { createShowcaseFeedQueryKey, type ShowcaseFeedPageParam } from './showcase-feed-query';
import type { ShowcaseFeedResponse } from './types';

// Home's For You lane, carried from one launch to the next.
//
// A cold start used to draw skeletons until the feed request answered. Home now
// saves the lane's first page whenever it settles, and the root layout puts that
// page back into the query cache at launch, so a returning person sees the posts
// they last saw while the refetch runs behind them. The page keeps the age it
// was fetched at: the lane's own staleTime decides whether a refetch follows,
// just as it does when the app comes back from the background.
//
// Showcase media are public showcase_media URLs, so a saved page holds no links
// that expire. A signed URL that turns up anyway is rerouted through /api/media
// by useMediaSource as it nears expiry.

/** The lane a cold start lands on, and the only one saved. */
export const PERSISTED_HOME_FEED_CHIP_ID: HomeFeedChipId = 'for-you';
export const PERSISTED_HOME_FEED_STORAGE_KEY = 'magicbooklet.homeFeed.forYou.v1';
/** Past this, a launch shows the skeleton rather than posts this old. */
export const PERSISTED_HOME_FEED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Folds a fetch and the edits right after it (a save, a hidden post) into one write. */
export const PERSIST_HOME_FEED_DEBOUNCE_MS = 1_000;

const PERSISTED_HOME_FEED_FORMAT = 1;
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;
// Lane data older than this module was fetched by an earlier launch, and the
// only way it reaches this one is the restore below.
const moduleLoadedAt = Date.now();

type HomeFeedData = InfiniteData<ShowcaseFeedResponse, ShowcaseFeedPageParam>;

export interface PersistedHomeFeedEnvironment {
  storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;
  appVersion: string;
  now: () => number;
}

interface PersistedHomeFeed {
  format: typeof PERSISTED_HOME_FEED_FORMAT;
  /** A new native build starts clean rather than reading an older build's copy. */
  appVersion: string;
  /** The registered viewer the page was ranked for; null for a guest or a signed-out device. */
  viewerUserId: string | null;
  /** When the page was fetched, or last edited in memory. Restored as the query's own age. */
  dataUpdatedAt: number;
  page: ShowcaseFeedResponse;
  pageParam: ShowcaseFeedPageParam;
}

function defaultEnvironment(): PersistedHomeFeedEnvironment {
  return {
    storage: AsyncStorage,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    now: Date.now,
  };
}

export function createPersistedHomeFeedQueryKey(viewerUserId: string | null | undefined) {
  const lane = HOME_FEED_CHIPS.find((chip) => chip.id === PERSISTED_HOME_FEED_CHIP_ID);
  return createShowcaseFeedQueryKey(lane?.filters, viewerUserId);
}

/** Whether lane data predates this launch, which only a restored page can. */
export function isPersistedHomeFeedData(dataUpdatedAt: number) {
  return dataUpdatedAt > 0 && dataUpdatedAt < moduleLoadedAt;
}

// Storage calls run one at a time, in the order they were asked for, so a
// restore's removal never lands on top of a newer write, and a write already
// under way never brings back a page that a sign-out has just cleared.
let storageQueue: Promise<unknown> = Promise.resolve();
let scheduledPersist: ReturnType<typeof setTimeout> | null = null;
let lastPersistedVersion: string | null = null;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation);
  storageQueue = result.catch(() => undefined);
  return result;
}

/**
 * Puts the saved page back under the For You key of the viewer it was saved
 * for. Resolves whether it did, and never rejects: a launch must not depend on
 * a cache.
 *
 * This runs before auth has said who the launch belongs to. A different viewer
 * never reads that key, and an unobserved page ages out of memory on its own.
 */
export async function restorePersistedHomeFeed(
  queryClient: QueryClient,
  environment: PersistedHomeFeedEnvironment = defaultEnvironment(),
): Promise<boolean> {
  try {
    const stored = await enqueue(async () => {
      const value = await environment.storage.getItem(PERSISTED_HOME_FEED_STORAGE_KEY);
      // Off the device before it is drawn. If a saved page ever crashed the
      // first render, the next launch would find nothing to restore instead of
      // crashing the same way. Home saves the page again once it has drawn it.
      if (value !== null) await environment.storage.removeItem(PERSISTED_HOME_FEED_STORAGE_KEY);
      return value;
    });
    const persisted = parsePersistedHomeFeed(stored, environment);
    if (!persisted) return false;

    const queryKey = createPersistedHomeFeedQueryKey(persisted.viewerUserId);
    const current = queryClient.getQueryState<HomeFeedData>(queryKey);
    // Whatever this launch has fetched already is newer than the saved page.
    if (current?.data !== undefined && current.dataUpdatedAt >= persisted.dataUpdatedAt) return false;
    // A request still out keeps running, and replaces the page when it lands.
    queryClient.setQueryData<HomeFeedData>(
      queryKey,
      { pages: [persisted.page], pageParams: [persisted.pageParam] },
      { updatedAt: persisted.dataUpdatedAt },
    );
    return true;
  } catch (error) {
    console.warn('Could not restore the saved home feed', error);
    return false;
  }
}

/**
 * Saves the viewer's For You first page as it sits in the cache now. A lane
 * that has not loaded, or holds no posts, is not saved: an empty page would
 * greet the next launch with "Nothing here yet" in place of a skeleton, for a
 * feed that may well have posts by then.
 */
export function persistHomeFeed(
  queryClient: QueryClient,
  viewerUserId: string | null | undefined,
  environment: PersistedHomeFeedEnvironment = defaultEnvironment(),
): Promise<void> {
  return enqueue(async () => {
    const state = queryClient.getQueryState<HomeFeedData>(createPersistedHomeFeedQueryKey(viewerUserId));
    const page = state?.data?.pages[0];
    if (!state || state.status !== 'success' || !page?.items.length) return;

    const persisted: PersistedHomeFeed = {
      format: PERSISTED_HOME_FEED_FORMAT,
      appVersion: environment.appVersion,
      viewerUserId: viewerUserId?.trim() || null,
      dataUpdatedAt: state.dataUpdatedAt,
      // The first page only. A restored infinite query refetches every page it
      // holds, one request after another, before the lane settles.
      page,
      pageParam: state.data?.pageParams[0] ?? { offset: 0 },
    };
    const version = `${persisted.appVersion}:${persisted.viewerUserId ?? ''}:${persisted.dataUpdatedAt}`;
    if (version === lastPersistedVersion) return;
    await environment.storage.setItem(PERSISTED_HOME_FEED_STORAGE_KEY, JSON.stringify(persisted));
    lastPersistedVersion = version;
  }).catch((error) => {
    console.warn('Could not save the home feed', error);
  });
}

export function schedulePersistHomeFeed(
  queryClient: QueryClient,
  viewerUserId: string | null | undefined,
  environment?: PersistedHomeFeedEnvironment,
) {
  cancelScheduledPersistHomeFeed();
  scheduledPersist = setTimeout(() => {
    scheduledPersist = null;
    void persistHomeFeed(queryClient, viewerUserId, environment);
  }, PERSIST_HOME_FEED_DEBOUNCE_MS);
}

export function cancelScheduledPersistHomeFeed() {
  if (scheduledPersist === null) return;
  clearTimeout(scheduledPersist);
  scheduledPersist = null;
}

/**
 * Forgets the saved page. Called wherever the signed-in session leaves the
 * device, so one person's ranked feed is never kept on disk for whoever comes
 * next. Never rejects: a sign-out must not fail over a cache.
 */
export async function clearPersistedHomeFeed(
  environment: PersistedHomeFeedEnvironment = defaultEnvironment(),
): Promise<void> {
  cancelScheduledPersistHomeFeed();
  lastPersistedVersion = null;
  await enqueue(() => environment.storage.removeItem(PERSISTED_HOME_FEED_STORAGE_KEY)).catch((error) => {
    console.warn('Could not clear the saved home feed', error);
  });
}

/** Test-only: forget the pending save and what was last written. */
export function resetPersistedHomeFeedForTests() {
  cancelScheduledPersistHomeFeed();
  lastPersistedVersion = null;
  storageQueue = Promise.resolve();
}

function parsePersistedHomeFeed(
  stored: string | null,
  { appVersion, now }: PersistedHomeFeedEnvironment,
): PersistedHomeFeed | null {
  if (!stored) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== PERSISTED_HOME_FEED_FORMAT || value.appVersion !== appVersion) {
    return null;
  }

  const { dataUpdatedAt, page, pageParam } = value;
  const viewerUserId = parseViewerUserId(value.viewerUserId);
  if (viewerUserId === undefined) return null;
  if (typeof dataUpdatedAt !== 'number' || !Number.isFinite(dataUpdatedAt)) return null;
  const age = now() - dataUpdatedAt;
  if (age > PERSISTED_HOME_FEED_MAX_AGE_MS || age < -CLOCK_SKEW_ALLOWANCE_MS) return null;
  if (!isDrawableFeedPage(page) || !isFeedPageParam(pageParam)) return null;

  return { format: PERSISTED_HOME_FEED_FORMAT, appVersion, viewerUserId, dataUpdatedAt, page, pageParam };
}

function parseViewerUserId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isDrawableFeedPage(value: unknown): value is ShowcaseFeedResponse {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.length > 0
    && value.items.every(isDrawableFeedItem);
}

// The fields a home card reads with no fallback (showcaseToHomeFeedCard). The
// page came from this app's own API, so this catches a truncated or outdated
// copy, not a hostile one.
function isDrawableFeedItem(value: unknown) {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.title === 'string'
    && typeof value.createdAt === 'string'
    && isRecord(value.creator)
    && (value.mediaItems === undefined || Array.isArray(value.mediaItems));
}

function isFeedPageParam(value: unknown): value is ShowcaseFeedPageParam {
  return isRecord(value)
    && (value.offset === undefined || (typeof value.offset === 'number' && Number.isFinite(value.offset)))
    && (value.cursor === undefined || typeof value.cursor === 'string')
    && (value.feedSessionId === undefined || typeof value.feedSessionId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

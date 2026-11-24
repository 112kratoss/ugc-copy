import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { setHomeShelfTakenOffListener } from './home-shelf-cache';
import { readHomeShelfItems } from './home-shelf-view-model';
import type { HomeShelfItem, HomeShelfResponse } from './types';

// Home's "Make this" shelf, carried from one launch to the next, as
// `persisted-home-feed.ts` carries the For You page.
//
// The shelf sits at the very top of Home, and its answer used to be asked only
// once auth had settled: on an S24 cold start the feed's saved page drew at
// ~2.1 s and the shelf's bones stayed until ~5.2 s (2026-11-24). Home now saves
// the shelf's answer for the identity it was asked under, and the root layout
// puts it back under that identity's key at launch. A different identity never
// reads that key, so nobody sees a shelf filtered by someone else's blocks and
// hides; and the copy leaves the device as it is read.
//
// What is kept is only what cannot mislead for the second or so before the
// fresh answer lands (`toSavedShelfItems`):
// - creations, without their price and without `fitsWelcomeCredits` (the
//   "Free to try" badge): a price is the catalog's and may have changed since.
//   The card draws without a price line until the refetch brings it; the
//   creator quotes afresh before any run, and the remix start is the server's,
//   so a press on a restored card is refused properly if the post has gone or
//   its remix was put behind a recipe (`startShowcaseRemix`).
// - the "Share your first post" offer, which states no figure.
// - not Invite or Earn: they state percentages of credits and sales.
//
// A restored answer is always stale (invalidated as it is put back), so the
// shelf's query refetches as soon as it is enabled, whatever its staleTime.
// Shelf media are the posts' public showcase_media URLs, as the feed's are, so
// a saved copy holds no link that expires.

export const PERSISTED_HOME_SHELF_STORAGE_KEY = 'magicbooklet.homeShelf.v1';
/**
 * Past this, a launch shows bones rather than a shelf this old. A week, the
 * feed's own limit, so a person who opens the app weekly gets both rows at
 * once rather than posts under a row of bones; nothing in the copy expires,
 * and the refetch replaces it within a second or two.
 */
export const PERSISTED_HOME_SHELF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Folds a fetch and the edits right after it (a card taken off) into one write. */
export const PERSIST_HOME_SHELF_DEBOUNCE_MS = 1_000;

const PERSISTED_HOME_SHELF_FORMAT = 1;
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

export interface PersistedHomeShelfEnvironment {
  storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;
  appVersion: string;
  now: () => number;
}

interface PersistedHomeShelf {
  format: typeof PERSISTED_HOME_SHELF_FORMAT;
  /** A new native build starts clean rather than reading an older build's copy. */
  appVersion: string;
  /** The backend identity (`identityUserId`, guest or registered) it was asked under; null for none. */
  viewerUserId: string | null;
  /** When the answer was fetched, or last edited in memory. */
  dataUpdatedAt: number;
  response: HomeShelfResponse;
}

function defaultEnvironment(): PersistedHomeShelfEnvironment {
  return {
    storage: AsyncStorage,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    now: Date.now,
  };
}

/** Home's own key for the shelf (`home-dashboard.tsx`). */
export function createHomeShelfQueryKey(identityUserId: string | null | undefined) {
  return ['home-shelf', identityUserId?.trim() || 'signed-out'] as const;
}

// One storage call at a time, in order, so a removal never lands under a newer
// write and a write under way never brings back a copy a sign-out cleared.
let storageQueue: Promise<unknown> = Promise.resolve();
let scheduledPersist: ReturnType<typeof setTimeout> | null = null;
let lastPersistedVersion: string | null = null;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation);
  storageQueue = result.catch(() => undefined);
  return result;
}

/**
 * The items a saved copy keeps, in the server's order: creations with no
 * price, and the one offer that names no figure. Empty when too few creations
 * would be left to draw a shelf (`readHomeShelfItems`).
 */
export function toSavedShelfItems(items: HomeShelfItem[]): HomeShelfItem[] {
  const kept = readHomeShelfItems({ success: true, schemaVersion: 0, items }).flatMap((item): HomeShelfItem[] => {
    if (item.kind === 'creation') return [{ ...item, price: null, fitsWelcomeCredits: false }];
    return item.id === 'post' ? [item] : [];
  });
  return readHomeShelfItems({ success: true, schemaVersion: 0, items: kept });
}

/**
 * Puts the saved shelf back under the key of the identity it was saved for,
 * and of no other, marked stale so it is asked again. Resolves whether it did
 * and never rejects: a launch must not depend on a cache.
 */
export async function restorePersistedHomeShelf(
  queryClient: QueryClient,
  environment: PersistedHomeShelfEnvironment = defaultEnvironment(),
): Promise<boolean> {
  try {
    const stored = await enqueue(async () => {
      const value = await environment.storage.getItem(PERSISTED_HOME_SHELF_STORAGE_KEY);
      // Off the device before it is drawn: a copy that crashed the first render
      // is not found again. Home saves the shelf again once it has drawn it.
      if (value !== null) await environment.storage.removeItem(PERSISTED_HOME_SHELF_STORAGE_KEY);
      return value;
    });
    const persisted = parsePersistedHomeShelf(stored, environment);
    if (!persisted) return false;

    const queryKey = createHomeShelfQueryKey(persisted.viewerUserId);
    const current = queryClient.getQueryState<HomeShelfResponse>(queryKey);
    // Whatever this launch has fetched already is newer than the saved copy.
    if (current?.data !== undefined && current.dataUpdatedAt >= persisted.dataUpdatedAt) return false;
    queryClient.setQueryData<HomeShelfResponse>(queryKey, persisted.response, {
      updatedAt: persisted.dataUpdatedAt,
    });
    // Stale by construction, however recently it was saved: the query refetches
    // as soon as Home enables it, and the fresh answer brings prices and offers.
    await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
    return true;
  } catch (error) {
    console.warn('Could not restore the saved home shelf', error);
    return false;
  }
}

/**
 * Saves the shelf of the backend identity as it sits in the cache now: after a
 * fetch, and after a card was taken off it (`takeOffHomeShelf`), so a block or
 * Hide holds on the next launch too. A shelf with nothing to draw is not saved.
 */
export function persistHomeShelf(
  queryClient: QueryClient,
  identityUserId: string | null | undefined,
  environment: PersistedHomeShelfEnvironment = defaultEnvironment(),
): Promise<void> {
  return enqueue(async () => {
    const state = queryClient.getQueryState<HomeShelfResponse>(createHomeShelfQueryKey(identityUserId));
    if (!state || state.status !== 'success' || !state.data) return;
    const items = toSavedShelfItems(state.data.items ?? []);
    if (!items.length) return;

    const persisted: PersistedHomeShelf = {
      format: PERSISTED_HOME_SHELF_FORMAT,
      appVersion: environment.appVersion,
      viewerUserId: identityUserId?.trim() || null,
      dataUpdatedAt: state.dataUpdatedAt,
      response: { ...state.data, items },
    };
    const version = `${persisted.appVersion}:${persisted.viewerUserId ?? ''}:${persisted.dataUpdatedAt}`;
    if (version === lastPersistedVersion) return;
    await environment.storage.setItem(PERSISTED_HOME_SHELF_STORAGE_KEY, JSON.stringify(persisted));
    lastPersistedVersion = version;
  }).catch((error) => {
    console.warn('Could not save the home shelf', error);
  });
}

export function schedulePersistHomeShelf(
  queryClient: QueryClient,
  identityUserId: string | null | undefined,
  environment?: PersistedHomeShelfEnvironment,
) {
  cancelScheduledPersistHomeShelf();
  scheduledPersist = setTimeout(() => {
    scheduledPersist = null;
    void persistHomeShelf(queryClient, identityUserId, environment);
  }, PERSIST_HOME_SHELF_DEBOUNCE_MS);
}

export function cancelScheduledPersistHomeShelf() {
  if (scheduledPersist === null) return;
  clearTimeout(scheduledPersist);
  scheduledPersist = null;
}

/**
 * Forgets the saved shelf. Called wherever the signed-in session leaves the
 * device, and as a card is taken off the shelf, so the copy on disk never
 * holds a card the viewer removed (Home saves the edited shelf right after).
 * Never rejects.
 */
export async function clearPersistedHomeShelf(
  environment: PersistedHomeShelfEnvironment = defaultEnvironment(),
): Promise<void> {
  cancelScheduledPersistHomeShelf();
  lastPersistedVersion = null;
  await enqueue(() => environment.storage.removeItem(PERSISTED_HOME_SHELF_STORAGE_KEY)).catch((error) => {
    console.warn('Could not clear the saved home shelf', error);
  });
}

// A block, Hide, Not interested or report takes a card off: the copy on disk
// still holds it, so it goes now, and Home saves the edited shelf after.
setHomeShelfTakenOffListener(() => {
  void clearPersistedHomeShelf();
});

/** Test-only: forget the pending save and what was last written. */
export function resetPersistedHomeShelfForTests() {
  cancelScheduledPersistHomeShelf();
  lastPersistedVersion = null;
  storageQueue = Promise.resolve();
}

function parsePersistedHomeShelf(
  stored: string | null,
  { appVersion, now }: PersistedHomeShelfEnvironment,
): PersistedHomeShelf | null {
  if (!stored) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== PERSISTED_HOME_SHELF_FORMAT || value.appVersion !== appVersion) {
    return null;
  }

  const { dataUpdatedAt, response } = value;
  const viewerUserId = value.viewerUserId === null
    ? null
    : typeof value.viewerUserId === 'string' && value.viewerUserId.trim() ? value.viewerUserId : undefined;
  if (viewerUserId === undefined) return null;
  if (typeof dataUpdatedAt !== 'number' || !Number.isFinite(dataUpdatedAt)) return null;
  const age = now() - dataUpdatedAt;
  if (age > PERSISTED_HOME_SHELF_MAX_AGE_MS || age < -CLOCK_SKEW_ALLOWANCE_MS) return null;
  if (!isRecord(response) || !Array.isArray(response.items)) return null;
  // Held to the same rule on the way back in: a copy from a build that kept
  // more is cut down to what this one keeps, and one too short is dropped.
  const items = toSavedShelfItems(response.items.filter(isDrawableShelfItem));
  if (!items.length) return null;

  return {
    format: PERSISTED_HOME_SHELF_FORMAT,
    appVersion,
    viewerUserId,
    dataUpdatedAt,
    response: { ...(response as unknown as HomeShelfResponse), items },
  };
}

// The fields a shelf card reads with no fallback. The copy came from this
// app's own API, so this catches a truncated or outdated copy, not a hostile one.
function isDrawableShelfItem(value: unknown): value is HomeShelfItem {
  if (!isRecord(value)) return false;
  if (value.kind === 'action') return typeof value.id === 'string';
  return value.kind === 'creation'
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.posterUrl === 'string'
    && isRecord(value.creator)
    && isRecord(value.post)
    && typeof value.post.id === 'string'
    && isRecord(value.post.creator);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

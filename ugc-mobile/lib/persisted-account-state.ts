import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import Constants from 'expo-constants';

import { NOTIFICATION_BADGE_QUERY_KEY, notificationBadgeQueryKey } from './notification-badge';
import type { ProfileResponse } from './types';

// The account's own numbers, carried from one launch to the next.
//
// The balance in the top bar, the side menu's balance and sales total, the
// profile header's counts and the Alerts badge all come from requests that
// wait on auth-js and then on the network, so every cold start drew a dash,
// "0 Credits", "Loading…" and no badge for as long as those took. The auth
// provider now saves what the account last showed whenever one of those values
// settles, and puts it back the moment the stored session names the same
// account, so a returning launch draws the last known numbers while the same
// requests refresh them behind it. Each query keeps the age it was fetched at:
// its own staleTime decides whether a refetch follows, just as on a return from
// the background. The profile carries the header counts and the seller total
// (`stats`, `sales`), so saving it saves them.
//
// Avatar and cover images are public profile-media URLs, so nothing saved here
// expires. Nothing here is a secret either: it is what the account's own
// screens draw, keyed by the user id the stored session already holds.

export const PERSISTED_ACCOUNT_STATE_STORAGE_KEY = 'magicbooklet.account.v1';
/** Past this, a launch shows the unknown-balance placeholder rather than numbers this old. */
export const PERSISTED_ACCOUNT_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Folds a fetch and the updates right after it (the balance, the badge) into one write. */
export const PERSIST_ACCOUNT_STATE_DEBOUNCE_MS = 1_000;
export const PROFILE_QUERY_KEY = 'profile';

const PERSISTED_ACCOUNT_STATE_FORMAT = 1;
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;

export interface PersistedAccountStateEnvironment {
  storage: Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;
  appVersion: string;
  now: () => number;
}

/** A query's data with the time it was fetched, restored as the query's own age. */
export interface PersistedQueryEntry<T> {
  data: T;
  updatedAt: number;
}

export interface PersistedAccountState {
  format: typeof PERSISTED_ACCOUNT_STATE_FORMAT;
  /** A new native build starts clean rather than reading an older build's copy. */
  appVersion: string;
  /** The backend identity the numbers belong to, guest or registered. */
  userId: string;
  /** When this copy was written. The balance carries no time of its own, so this stands in. */
  savedAt: number;
  /** The auth provider's balance, which a spend or a purchase may have moved past the profile's copy. */
  credits: number | null;
  profile: PersistedQueryEntry<ProfileResponse> | null;
  unreadCount: PersistedQueryEntry<number> | null;
}

/** What the auth provider knows at the moment it saves or restores. */
export interface AccountStateSnapshot {
  userId: string;
  credits: number | null;
}

export interface RestoredAccountState {
  credits: number | null;
  savedAt: number;
}

function defaultEnvironment(): PersistedAccountStateEnvironment {
  return {
    storage: AsyncStorage,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    now: Date.now,
  };
}

export function profileQueryKey(userId: string | undefined) {
  return [PROFILE_QUERY_KEY, userId] as const;
}

/** Whether a cache entry is one of the account's saved queries, under this user's key. */
export function isPersistedAccountQueryKey(queryKey: QueryKey, userId: string) {
  if (!Array.isArray(queryKey) || queryKey.length !== 2 || queryKey[1] !== userId) return false;
  const scope = queryKey[0];
  return scope === PROFILE_QUERY_KEY || scope === NOTIFICATION_BADGE_QUERY_KEY;
}

// Storage calls run one at a time, in the order they were asked for, so the
// launch read's removal never lands on top of a newer write, and a write already
// under way never brings back numbers that a sign-out has just cleared.
let storageQueue: Promise<unknown> = Promise.resolve();
let scheduledPersist: ReturnType<typeof setTimeout> | null = null;
let lastPersistedVersion: string | null = null;
// This launch's one read of the saved copy, and the account it has been handed to.
let pendingRead: Promise<PersistedAccountState | null> | null = null;
let restoredUserId: string | null = null;

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(operation);
  storageQueue = result.catch(() => undefined);
  return result;
}

/**
 * Reads the saved copy off the device, once per launch, and takes it off the
 * device before it is drawn: if a saved copy ever crashed the first render, the
 * next launch would find nothing to restore instead of crashing the same way.
 * The provider saves the numbers again once they are on screen.
 *
 * The root layout starts this beside the home feed restore, before auth has
 * said whose launch it is, so the copy is in hand by the time the stored
 * session names its account. Never rejects: a launch must not depend on a cache.
 */
export function preloadPersistedAccountState(
  environment: PersistedAccountStateEnvironment = defaultEnvironment(),
): Promise<PersistedAccountState | null> {
  if (!pendingRead) {
    pendingRead = enqueue(async () => {
      const value = await environment.storage.getItem(PERSISTED_ACCOUNT_STATE_STORAGE_KEY);
      if (value !== null) await environment.storage.removeItem(PERSISTED_ACCOUNT_STATE_STORAGE_KEY);
      return parsePersistedAccountState(value, environment);
    }).catch((error) => {
      console.warn('Could not read the saved account state', error);
      return null;
    });
  }
  return pendingRead;
}

/**
 * Puts the saved queries back under this account's keys and hands back the
 * balance it held, or null when the copy is for someone else, too old, or has
 * already been restored this launch. The provider applies the balance itself,
 * because only it knows whether the server has answered in the meantime.
 */
export async function restorePersistedAccountState(
  queryClient: Pick<QueryClient, 'getQueryState' | 'setQueryData'>,
  identity: { userId: string },
  environment: PersistedAccountStateEnvironment = defaultEnvironment(),
): Promise<RestoredAccountState | null> {
  const persisted = await preloadPersistedAccountState(environment);
  if (!persisted || persisted.userId !== identity.userId || restoredUserId === persisted.userId) return null;
  restoredUserId = persisted.userId;
  try {
    seedQuery(queryClient, profileQueryKey(persisted.userId), persisted.profile);
    seedQuery(queryClient, notificationBadgeQueryKey(persisted.userId), persisted.unreadCount);
  } catch (error) {
    console.warn('Could not restore the saved account state', error);
  }
  return { credits: persisted.credits, savedAt: persisted.savedAt };
}

function seedQuery<T>(
  queryClient: Pick<QueryClient, 'getQueryState' | 'setQueryData'>,
  queryKey: QueryKey,
  entry: PersistedQueryEntry<T> | null,
) {
  if (!entry) return;
  const current = queryClient.getQueryState<T>(queryKey);
  // Whatever this launch has fetched already is newer than the saved copy.
  if (current?.data !== undefined && current.dataUpdatedAt >= entry.updatedAt) return;
  // A request still out keeps running, and replaces the copy when it lands.
  queryClient.setQueryData<T>(queryKey, entry.data, { updatedAt: entry.updatedAt });
}

/**
 * Saves the account's numbers as they sit in the cache and the provider now.
 * Until the balance or the profile has loaded there is nothing worth saving: an
 * empty copy would give the next launch nothing to draw either.
 */
export function persistAccountState(
  queryClient: Pick<QueryClient, 'getQueryState'>,
  snapshot: AccountStateSnapshot,
  environment: PersistedAccountStateEnvironment = defaultEnvironment(),
): Promise<void> {
  return enqueue(async () => {
    const { userId, credits } = snapshot;
    const profile = readEntry<ProfileResponse>(queryClient, profileQueryKey(userId));
    if (credits === null && !profile) return;
    const unreadCount = readEntry<number>(queryClient, notificationBadgeQueryKey(userId));

    const persisted: PersistedAccountState = {
      format: PERSISTED_ACCOUNT_STATE_FORMAT,
      appVersion: environment.appVersion,
      userId,
      savedAt: environment.now(),
      credits,
      profile,
      unreadCount,
    };
    const version = [
      persisted.appVersion,
      userId,
      credits,
      profile?.updatedAt,
      unreadCount?.updatedAt,
    ].join(':');
    if (version === lastPersistedVersion) return;
    await environment.storage.setItem(PERSISTED_ACCOUNT_STATE_STORAGE_KEY, JSON.stringify(persisted));
    lastPersistedVersion = version;
  }).catch((error) => {
    console.warn('Could not save the account state', error);
  });
}

function readEntry<T>(
  queryClient: Pick<QueryClient, 'getQueryState'>,
  queryKey: QueryKey,
): PersistedQueryEntry<T> | null {
  const state = queryClient.getQueryState<T>(queryKey);
  if (!state || state.status !== 'success' || state.data === undefined) return null;
  return { data: state.data, updatedAt: state.dataUpdatedAt };
}

export function schedulePersistAccountState(
  queryClient: Pick<QueryClient, 'getQueryState'>,
  snapshot: AccountStateSnapshot,
  environment?: PersistedAccountStateEnvironment,
) {
  cancelScheduledPersistAccountState();
  scheduledPersist = setTimeout(() => {
    scheduledPersist = null;
    void persistAccountState(queryClient, snapshot, environment);
  }, PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
}

export function cancelScheduledPersistAccountState() {
  if (scheduledPersist === null) return;
  clearTimeout(scheduledPersist);
  scheduledPersist = null;
}

/**
 * Saves now, and again whenever one of the account's queries settles — a fetch
 * landing, or a screen writing a fresher value into the cache — until the
 * returned function is called. The provider calls this once per balance value,
 * so a spend or a purchase is saved the same way.
 */
export function persistAccountStateOnChange(
  queryClient: Pick<QueryClient, 'getQueryState' | 'getQueryCache'>,
  snapshot: AccountStateSnapshot,
  environment?: PersistedAccountStateEnvironment,
): () => void {
  schedulePersistAccountState(queryClient, snapshot, environment);
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!isPersistedAccountQueryKey(event.query.queryKey, snapshot.userId)) return;
    schedulePersistAccountState(queryClient, snapshot, environment);
  });
  return () => {
    unsubscribe();
    cancelScheduledPersistAccountState();
  };
}

/**
 * Forgets the saved numbers, on disk and in hand. Called wherever the session
 * leaves the device, so one person's balance is never kept for whoever comes
 * next. Never rejects: a sign-out must not fail over a cache.
 */
export async function clearPersistedAccountState(
  environment: PersistedAccountStateEnvironment = defaultEnvironment(),
): Promise<void> {
  cancelScheduledPersistAccountState();
  lastPersistedVersion = null;
  pendingRead = null;
  restoredUserId = null;
  await enqueue(() => environment.storage.removeItem(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).catch((error) => {
    console.warn('Could not clear the saved account state', error);
  });
}

/** Test-only: forget the pending save, this launch's read, and what was last written. */
export function resetPersistedAccountStateForTests() {
  cancelScheduledPersistAccountState();
  lastPersistedVersion = null;
  pendingRead = null;
  restoredUserId = null;
  storageQueue = Promise.resolve();
}

function parsePersistedAccountState(
  stored: string | null,
  { appVersion, now }: PersistedAccountStateEnvironment,
): PersistedAccountState | null {
  if (!stored) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.format !== PERSISTED_ACCOUNT_STATE_FORMAT || value.appVersion !== appVersion) {
    return null;
  }

  const { userId, savedAt, credits } = value;
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (!isFiniteNumber(savedAt)) return null;
  const currentTime = now();
  const age = currentTime - savedAt;
  if (age > PERSISTED_ACCOUNT_STATE_MAX_AGE_MS || age < -CLOCK_SKEW_ALLOWANCE_MS) return null;
  if (credits !== null && !(isFiniteNumber(credits) && credits >= 0)) return null;

  // A copy from before the profile carried the seller total also held a
  // `salesSummary` entry; it is simply not read.
  const profile = parseEntry(value.profile, currentTime, (data): data is ProfileResponse => isDrawableProfile(data, userId));
  const unreadCount = parseEntry(value.unreadCount, currentTime, (data): data is number => isFiniteNumber(data) && data >= 0);
  if (profile === undefined || unreadCount === undefined) return null;

  return {
    format: PERSISTED_ACCOUNT_STATE_FORMAT,
    appVersion,
    userId,
    savedAt,
    credits,
    profile,
    unreadCount,
  };
}

/** `undefined` for a damaged entry, which discards the whole copy; null for an absent one. */
function parseEntry<T>(
  value: unknown,
  currentTime: number,
  isData: (data: unknown) => data is T,
): PersistedQueryEntry<T> | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isFiniteNumber(value.updatedAt) || value.updatedAt <= 0) return undefined;
  if (value.updatedAt > currentTime + CLOCK_SKEW_ALLOWANCE_MS) return undefined;
  if (!isData(value.data)) return undefined;
  return { data: value.data, updatedAt: value.updatedAt };
}

// The fields the side menu and the profile header read. The copy came from this
// app's own API, so this catches a truncated or outdated one, not a hostile one.
function isDrawableProfile(value: unknown, userId: string): value is ProfileResponse {
  return isRecord(value)
    && value.id === userId
    && isStringOrNull(value.username)
    && isStringOrNull(value.displayName)
    && isStringOrNull(value.bio)
    && isStringOrNull(value.avatarUrl)
    && isStringOrNull(value.coverUrl)
    && (value.credits === null || isFiniteNumber(value.credits));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

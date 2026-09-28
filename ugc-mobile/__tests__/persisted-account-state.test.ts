import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.8' } } }));

import { notificationBadgeQueryKey } from '@/lib/notification-badge';
import {
  PERSISTED_ACCOUNT_STATE_MAX_AGE_MS,
  PERSISTED_ACCOUNT_STATE_STORAGE_KEY,
  PERSIST_ACCOUNT_STATE_DEBOUNCE_MS,
  cancelScheduledPersistAccountState,
  clearPersistedAccountState,
  isPersistedAccountQueryKey,
  persistAccountState,
  persistAccountStateOnChange,
  preloadPersistedAccountState,
  profileQueryKey,
  resetPersistedAccountStateForTests,
  restorePersistedAccountState,
  schedulePersistAccountState,
  type PersistedAccountStateEnvironment,
} from '@/lib/persisted-account-state';
import type { ProfileResponse } from '@/lib/types';

const FETCHED_AT = Date.parse('2026-09-27T08:00:00.000Z');
const APP_VERSION = '0.1.8';
const USER_ID = 'user-1';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

type MemoryStorage = ReturnType<typeof memoryStorage>;

function environment(storage: MemoryStorage, now = FETCHED_AT + 60_000): PersistedAccountStateEnvironment {
  return { storage, appVersion: APP_VERSION, now: () => now };
}

function profile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: USER_ID,
    username: 'luna_dreams',
    displayName: 'Luna Dreams',
    bio: 'Dreaming in colour',
    avatarUrl: 'https://project.supabase.co/storage/v1/object/public/profile-media/user-1/avatar.webp',
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: 26_700,
    ...overrides,
  };
}

/** A client holding what the account's screens fetched, each at its own time. */
function clientWithAccount({
  profileData = profile(),
  profileAt = FETCHED_AT,
  unread = 2 as number | null,
  unreadAt = FETCHED_AT - 10_000,
} = {}) {
  const client = new QueryClient();
  client.setQueryData(profileQueryKey(USER_ID), profileData, { updatedAt: profileAt });
  if (unread !== null) client.setQueryData(notificationBadgeQueryKey(USER_ID), unread, { updatedAt: unreadAt });
  return client;
}

/** What the next launch finds: the copy on disk, and nothing in memory. */
async function storageHolding(client = clientWithAccount(), credits: number | null = 26_800) {
  const storage = memoryStorage();
  await persistAccountState(client, { userId: USER_ID, credits }, environment(storage));
  resetPersistedAccountStateForTests();
  vi.clearAllMocks();
  return storage;
}

function saved(storage: MemoryStorage) {
  return JSON.parse(storage.values.get(PERSISTED_ACCOUNT_STATE_STORAGE_KEY) ?? 'null');
}

function storedCopy(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    format: 1,
    appVersion: APP_VERSION,
    userId: USER_ID,
    savedAt: FETCHED_AT,
    credits: 26_800,
    profile: { data: profile(), updatedAt: FETCHED_AT },
    salesSummary: null,
    unreadCount: null,
    ...overrides,
  });
}

beforeEach(() => {
  resetPersistedAccountStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the saved queries', () => {
  it("are the profile and the unread count, under the account's own key", () => {
    expect(isPersistedAccountQueryKey(profileQueryKey(USER_ID), USER_ID)).toBe(true);
    // The seller total rides on the profile; the old menu query is not one of them.
    expect(isPersistedAccountQueryKey(['owner-posts-sales-summary', USER_ID], USER_ID)).toBe(false);
    expect(isPersistedAccountQueryKey(notificationBadgeQueryKey(USER_ID), USER_ID)).toBe(true);

    expect(isPersistedAccountQueryKey(profileQueryKey('user-2'), USER_ID)).toBe(false);
    expect(isPersistedAccountQueryKey(['profile-generations', USER_ID], USER_ID)).toBe(false);
    expect(isPersistedAccountQueryKey(['profile', USER_ID, 'extra'], USER_ID)).toBe(false);
    expect(isPersistedAccountQueryKey('profile' as unknown as readonly unknown[], USER_ID)).toBe(false);
  });
});

describe('persistAccountState', () => {
  it('saves the balance with the profile and the unread count, each as old as it was fetched', async () => {
    const storage = memoryStorage();

    await persistAccountState(clientWithAccount(), { userId: USER_ID, credits: 26_800 }, environment(storage));

    expect(saved(storage)).toMatchObject({
      format: 1,
      appVersion: APP_VERSION,
      userId: USER_ID,
      savedAt: FETCHED_AT + 60_000,
      credits: 26_800,
      profile: { data: { id: USER_ID, username: 'luna_dreams', credits: 26_700 }, updatedAt: FETCHED_AT },
      unreadCount: { data: 2, updatedAt: FETCHED_AT - 10_000 },
    });
    expect(saved(storage)).not.toHaveProperty('salesSummary');
  });

  it('saves nothing until the balance or the profile has loaded', async () => {
    const storage = memoryStorage();

    await persistAccountState(new QueryClient(), { userId: USER_ID, credits: null }, environment(storage));
    expect(storage.setItem).not.toHaveBeenCalled();

    await persistAccountState(new QueryClient(), { userId: USER_ID, credits: 40 }, environment(storage));
    expect(saved(storage)).toMatchObject({ credits: 40, profile: null, unreadCount: null });
  });

  it('skips the write when nothing has changed since the last one', async () => {
    const storage = memoryStorage();
    const client = clientWithAccount();

    await persistAccountState(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    await persistAccountState(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    expect(storage.setItem).toHaveBeenCalledOnce();

    await persistAccountState(client, { userId: USER_ID, credits: 26_500 }, environment(storage));
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(saved(storage).credits).toBe(26_500);

    client.setQueryData(notificationBadgeQueryKey(USER_ID), 0, { updatedAt: FETCHED_AT + 5_000 });
    await persistAccountState(client, { userId: USER_ID, credits: 26_500 }, environment(storage));
    expect(storage.setItem).toHaveBeenCalledTimes(3);
    expect(saved(storage).unreadCount).toEqual({ data: 0, updatedAt: FETCHED_AT + 5_000 });
  });
});

describe('restorePersistedAccountState', () => {
  it("puts the queries back under the account's keys, as old as when they were fetched, and hands back the balance", async () => {
    const storage = await storageHolding();
    const client = new QueryClient();

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage)))
      .resolves.toEqual({ credits: 26_800, savedAt: FETCHED_AT + 60_000 });

    const profileState = client.getQueryState<ProfileResponse>(profileQueryKey(USER_ID));
    expect(profileState?.data?.displayName).toBe('Luna Dreams');
    expect(profileState?.dataUpdatedAt).toBe(FETCHED_AT);
    const badgeState = client.getQueryState<number>(notificationBadgeQueryKey(USER_ID));
    expect(badgeState?.data).toBe(2);
    expect(badgeState?.dataUpdatedAt).toBe(FETCHED_AT - 10_000);
  });

  it('restores a copy holding only the balance', async () => {
    const storage = await storageHolding(new QueryClient(), 40);
    const client = new QueryClient();

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage)))
      .resolves.toMatchObject({ credits: 40 });

    expect(client.getQueryState(profileQueryKey(USER_ID))).toBeUndefined();
  });

  it('takes the saved copy off the device before it is drawn', async () => {
    const storage = await storageHolding();

    await preloadPersistedAccountState(environment(storage));

    expect(storage.values.has(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).toBe(false);
  });

  it('reads the device once per launch, however early the read starts', async () => {
    const storage = await storageHolding();

    const preload = preloadPersistedAccountState(environment(storage));
    const restored = restorePersistedAccountState(new QueryClient(), { userId: USER_ID }, environment(storage));

    await expect(preload).resolves.toMatchObject({ userId: USER_ID });
    await expect(restored).resolves.toMatchObject({ credits: 26_800 });
    expect(storage.getItem).toHaveBeenCalledOnce();
  });

  it('never replaces what this launch has already fetched', async () => {
    const storage = await storageHolding();
    const client = clientWithAccount({
      profileData: profile({ displayName: 'Fresh name' }),
      profileAt: FETCHED_AT + 30_000,
      unread: null,
    });

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage)))
      .resolves.toMatchObject({ credits: 26_800 });

    expect(client.getQueryData<ProfileResponse>(profileQueryKey(USER_ID))?.displayName).toBe('Fresh name');
    // The queries this launch had not fetched yet are still filled in.
    expect(client.getQueryData<number>(notificationBadgeQueryKey(USER_ID))).toBe(2);
  });

  it('fills a query whose request is still out, and leaves the request running', async () => {
    const storage = await storageHolding();
    const client = new QueryClient();
    void client.fetchQuery({
      queryKey: profileQueryKey(USER_ID),
      queryFn: () => new Promise<ProfileResponse>(() => undefined),
    });

    await restorePersistedAccountState(client, { userId: USER_ID }, environment(storage));

    const state = client.getQueryState<ProfileResponse>(profileQueryKey(USER_ID));
    expect(state).toMatchObject({ status: 'success', fetchStatus: 'fetching' });
    expect(state?.data?.displayName).toBe('Luna Dreams');
  });

  it("keeps another account's copy off screen, and still in hand for that account", async () => {
    const storage = await storageHolding();
    const client = new QueryClient();

    await expect(restorePersistedAccountState(client, { userId: 'user-2' }, environment(storage))).resolves.toBeNull();
    expect(client.getQueryState(profileQueryKey('user-2'))).toBeUndefined();
    expect(client.getQueryState(profileQueryKey(USER_ID))).toBeUndefined();

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage)))
      .resolves.toMatchObject({ credits: 26_800 });
  });

  it('restores once per launch', async () => {
    const storage = await storageHolding();
    const client = new QueryClient();

    await restorePersistedAccountState(client, { userId: USER_ID }, environment(storage));
    client.setQueryData(profileQueryKey(USER_ID), profile({ displayName: 'Fresh name' }), { updatedAt: FETCHED_AT + 1 });

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage))).resolves.toBeNull();
    expect(client.getQueryData<ProfileResponse>(profileQueryKey(USER_ID))?.displayName).toBe('Fresh name');
  });

  it.each([
    ['a copy saved by another app version', storedCopy({ appVersion: '0.1.7' }), FETCHED_AT + 60_000],
    ['a copy older than the age limit', storedCopy(), FETCHED_AT + PERSISTED_ACCOUNT_STATE_MAX_AGE_MS + 1],
    ['a copy saved in the future', storedCopy({ savedAt: FETCHED_AT + 10 * 60_000 }), FETCHED_AT],
    ['a copy with no account', storedCopy({ userId: '' }), FETCHED_AT + 60_000],
    ['a negative balance', storedCopy({ credits: -1 }), FETCHED_AT + 60_000],
    ["a profile that is not this account's", storedCopy({ profile: { data: profile({ id: 'user-2' }), updatedAt: FETCHED_AT } }), FETCHED_AT + 60_000],
    ['a profile with a field missing', storedCopy({ profile: { data: { id: USER_ID, username: 'luna_dreams' }, updatedAt: FETCHED_AT } }), FETCHED_AT + 60_000],
    ['a query fetched in the future', storedCopy({ profile: { data: profile(), updatedAt: FETCHED_AT + 10 * 60_000 } }), FETCHED_AT],
    ['an unread count that is not a count', storedCopy({ unreadCount: { data: 'two', updatedAt: FETCHED_AT } }), FETCHED_AT + 60_000],
    ['something that is not a copy at all', '{"format":', FETCHED_AT + 60_000],
  ])('ignores %s and leaves the launch to fetch', async (_label, stored, now) => {
    const storage = memoryStorage();
    storage.values.set(PERSISTED_ACCOUNT_STATE_STORAGE_KEY, stored);
    const client = new QueryClient();

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage, now))).resolves.toBeNull();

    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(storage.values.has(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).toBe(false);
  });

  it('ignores the seller summary an older copy carried, and restores the rest', async () => {
    const storage = memoryStorage();
    storage.values.set(PERSISTED_ACCOUNT_STATE_STORAGE_KEY, storedCopy({
      salesSummary: { data: { success: true, posts: [], summary: { earningsUsdCents: 1, listingCount: 1, salesCount: 1 } }, updatedAt: FETCHED_AT },
    }));
    const client = new QueryClient();

    await expect(restorePersistedAccountState(client, { userId: USER_ID }, environment(storage)))
      .resolves.toMatchObject({ credits: 26_800 });

    expect(client.getQueryCache().getAll().map((query) => query.queryKey[0])).toEqual(['profile']);
  });

  it('counts a balance of nothing as known, unlike no copy at all', async () => {
    const storage = memoryStorage();
    storage.values.set(PERSISTED_ACCOUNT_STATE_STORAGE_KEY, storedCopy({ credits: 0 }));

    await expect(restorePersistedAccountState(new QueryClient(), { userId: USER_ID }, environment(storage)))
      .resolves.toMatchObject({ credits: 0 });
  });

  it('never rejects, whatever the device does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = memoryStorage();
    storage.getItem.mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(restorePersistedAccountState(new QueryClient(), { userId: USER_ID }, environment(storage))).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith('Could not read the saved account state', expect.any(Error));
    warn.mockRestore();
  });
});

describe('persistAccountStateOnChange', () => {
  it("saves now, and again whenever one of the account's queries settles, until it is stopped", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = clientWithAccount();

    const stop = persistAccountStateOnChange(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledOnce();

    client.setQueryData(notificationBadgeQueryKey(USER_ID), 5, { updatedAt: FETCHED_AT + 5_000 });
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(saved(storage).unreadCount).toEqual({ data: 5, updatedAt: FETCHED_AT + 5_000 });

    // Another account's query, or one this copy does not hold, is not a reason to write.
    client.setQueryData(profileQueryKey('user-2'), profile({ id: 'user-2' }), { updatedAt: FETCHED_AT + 6_000 });
    client.setQueryData(['profile-generations', USER_ID], { pages: [] }, { updatedAt: FETCHED_AT + 6_000 });
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledTimes(2);

    stop();
    client.setQueryData(notificationBadgeQueryKey(USER_ID), 6, { updatedAt: FETCHED_AT + 7_000 });
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('saves a fetch that lands, not the request going out', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = clientWithAccount();
    let answer: (value: number) => void = () => undefined;

    persistAccountStateOnChange(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledOnce();

    void client.fetchQuery({
      queryKey: notificationBadgeQueryKey(USER_ID),
      queryFn: () => new Promise<number>((resolve) => {
        answer = resolve;
      }),
      staleTime: 0,
    });
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledOnce();

    answer(9);
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(saved(storage).unreadCount.data).toBe(9);
  });

  it('drops a save still waiting when it is stopped', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();

    const stop = persistAccountStateOnChange(clientWithAccount(), { userId: USER_ID, credits: 26_800 }, environment(storage));
    stop();
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS * 2);

    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('scheduled saves and clearing', () => {
  it('folds a burst of changes into one write of the latest values', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = clientWithAccount();

    schedulePersistAccountState(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    schedulePersistAccountState(client, { userId: USER_ID, credits: 26_700 }, environment(storage));
    schedulePersistAccountState(client, { userId: USER_ID, credits: 26_600 }, environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);

    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    expect(saved(storage).credits).toBe(26_600);
  });

  it('drops a waiting save when it is cancelled', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();

    schedulePersistAccountState(clientWithAccount(), { userId: USER_ID, credits: 26_800 }, environment(storage));
    cancelScheduledPersistAccountState();
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS * 2);

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("removes the saved copy, cancels a save still waiting, and forgets this launch's read", async () => {
    vi.useFakeTimers();
    const storage = await storageHolding();
    const read = preloadPersistedAccountState(environment(storage));

    schedulePersistAccountState(clientWithAccount(), { userId: USER_ID, credits: 26_700 }, environment(storage));
    await clearPersistedAccountState(environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS * 2);

    expect(storage.values.has(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    await expect(read).resolves.toMatchObject({ userId: USER_ID });
    // The copy read before the sign-out is not handed to whoever signs in next.
    await expect(restorePersistedAccountState(new QueryClient(), { userId: USER_ID }, environment(storage))).resolves.toBeNull();
  });

  it('lands after a write already under way, so that write cannot undo a sign-out', async () => {
    const storage = memoryStorage();
    let finishWrite = () => undefined as void;
    storage.setItem.mockImplementationOnce((key, value) => new Promise<void>((resolveWrite) => {
      finishWrite = () => {
        storage.values.set(key, value);
        resolveWrite();
      };
    }));

    const write = persistAccountState(clientWithAccount(), { userId: USER_ID, credits: 26_800 }, environment(storage));
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    const clear = clearPersistedAccountState(environment(storage));
    finishWrite();
    await Promise.all([write, clear]);

    expect(storage.values.has(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).toBe(false);
  });

  it('writes the restored copy back once the launch has drawn it', async () => {
    vi.useFakeTimers();
    const storage = await storageHolding();
    const client = new QueryClient();

    await restorePersistedAccountState(client, { userId: USER_ID }, environment(storage));
    expect(storage.values.has(PERSISTED_ACCOUNT_STATE_STORAGE_KEY)).toBe(false);
    persistAccountStateOnChange(client, { userId: USER_ID, credits: 26_800 }, environment(storage));
    await vi.advanceTimersByTimeAsync(PERSIST_ACCOUNT_STATE_DEBOUNCE_MS);

    expect(saved(storage)).toMatchObject({ credits: 26_800, profile: { updatedAt: FETCHED_AT } });
  });
});

describe('wiring', () => {
  const mobileRoot = path.resolve(__dirname, '..');
  const read = (file: string) => readFileSync(path.join(mobileRoot, file), 'utf8');

  it('reads the copy from the eagerly loaded root layout, beside the feed restore', () => {
    const layout = read('app/_layout.tsx');
    const feedRestoreAt = layout.indexOf('void restorePersistedHomeFeed(queryClient);');

    expect(feedRestoreAt).toBeGreaterThan(-1);
    expect(layout.indexOf('void preloadPersistedAccountState();')).toBeGreaterThan(feedRestoreAt);
  });

  it('restores the moment the session names an account, and saves for as long as one is signed in', () => {
    const auth = read('lib/auth.tsx');
    const applySessionStart = auth.indexOf('const applySessionState');
    const applySessionEnd = auth.indexOf('const resetAuthState', applySessionStart);
    const applySessionSource = auth.slice(applySessionStart, applySessionEnd);

    expect(applySessionSource).toContain('if (userChanged && nextUserId) restoreAccountState(nextUserId, authStateVersionRef.current);');
    expect(auth).toContain('return persistAccountStateOnChange(queryClient, { userId: identityUserId, credits });');
    // A balance from the server or from a spend is never overwritten by the copy.
    expect(auth).toContain('creditsSettledVersionRef.current === version) return;');
  });

  it('forgets the saved copy everywhere the signed-in session is cleared from the device', () => {
    const auth = read('lib/auth.tsx');
    const count = (needle: string) => auth.split(needle).length - 1;

    expect(count('clearPersistedSupabaseAuthSession()')).toBeGreaterThan(0);
    expect(count('clearPersistedAccountState()')).toBe(count('clearPersistedSupabaseAuthSession()'));
  });

  it('never draws an unknown balance as 0', () => {
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return sourceFiles(absolutePath);
      return /\.tsx?$/.test(entry) ? [absolutePath] : [];
    });
    const zeroed = ['app', 'components']
      .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
      .filter((file) => /\bcredits \?\? 0\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(mobileRoot, file));

    expect(zeroed).toEqual([]);
  });
});

// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CacheEvent = {
  type: string;
  action: { type: string; manual?: boolean };
  query: { queryKey: readonly unknown[]; state: { data: unknown; dataUpdatedAt: number } };
};

const state = vi.hoisted(() => {
  const appStateListeners = new Set<(next: string) => void>();
  const cacheListeners = new Set<(event: unknown) => void>();
  return {
    appStateListeners,
    authCallback: null as null | ((event: string, session: unknown) => void),
    // The balance each identity's profile read answers with.
    balances: {} as Record<string, number>,
    cacheListeners,
    clearSearchHistory: vi.fn(),
    deleteAccount: vi.fn(),
    dismissTo: vi.fn(),
    getAccessToken: null as null | (() => Promise<string | null>),
    getSession: vi.fn(),
    mergeGuestAccount: vi.fn(),
    // What Platform.OS reads: Google is offered on both phones (D1).
    platform: 'web' as 'web' | 'ios' | 'android',
    prepareGuestAccountMerge: vi.fn(),
    queryClient: {
      clear: vi.fn(),
      fetchQuery: vi.fn(),
      getQueryCache: () => ({
        subscribe: (listener: (event: unknown) => void) => {
          cacheListeners.add(listener);
          return () => {
            cacheListeners.delete(listener);
          };
        },
      }),
      removeQueries: vi.fn(),
    },
    replace: vi.fn(),
    // The device keychain, as expo-secure-store holds it.
    secureStore: new Map<string, string>(),
    signInAnonymously: vi.fn(),
    signInWithGoogleOAuth: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    updateUser: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => state.queryClient,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.0.0' } },
}));

// One stable object, never a fresh literal per render: an unstable router mock
// re-runs the provider's effects forever and hangs the suite.
vi.mock('expo-router', () => ({
  router: { replace: state.replace, dismissTo: state.dismissTo },
  usePathname: () => '/',
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.appStateListeners.add(listener);
      return { remove: () => state.appStateListeners.delete(listener) };
    },
  },
  Platform: {
    get OS() {
      return state.platform;
    },
  },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => state.secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    state.secureStore.delete(key);
  },
}));

vi.mock('../lib/env', () => ({
  env: {
    apiBaseUrl: 'https://api.example.com',
    supabaseUrl: 'https://project.supabase.example',
    supabasePublishableKey: 'publishable-key',
  },
  getMissingMobileEnvKeys: () => [],
}));

vi.mock('../lib/api-client', () => ({
  ACCOUNT_DELETING_CODE: 'ACCOUNT_DELETING',
  ApiError: class ApiError extends Error {},
  isRequestTimeoutError: () => false,
  createApiClient: (options: { getAccessToken: () => Promise<string | null> }) => {
    state.getAccessToken = options.getAccessToken;
    return {
      deleteAccount: state.deleteAccount,
      getProfile: vi.fn(),
      mergeGuestAccount: state.mergeGuestAccount,
      prepareGuestAccountMerge: state.prepareGuestAccountMerge,
    };
  },
}));

vi.mock('../lib/feed-installation-id', () => ({ getFeedInstallationId: vi.fn() }));
vi.mock('../lib/feed-event-queue', () => ({
  beginShowcaseFeedEventIdentityTransition: () => ({ cancel: vi.fn(), commit: vi.fn() }),
  configureFeedEventQueue: vi.fn(),
  flushShowcaseFeedEvents: vi.fn(async () => undefined),
  restoreShowcaseFeedEvents: vi.fn(async () => undefined),
}));
vi.mock('../lib/generation-model-catalog', () => ({ GENERATION_MODEL_CATALOG_SCHEMA_VERSION: 1 }));
vi.mock('../lib/persisted-account-state', () => ({
  clearPersistedAccountState: vi.fn(async () => undefined),
  persistAccountStateOnChange: vi.fn(() => () => undefined),
  restorePersistedAccountState: vi.fn(async () => null),
}));
vi.mock('../lib/persisted-home-feed', () => ({ clearPersistedHomeFeed: vi.fn(async () => undefined) }));
vi.mock('../lib/search-history', () => ({ clearSearchHistory: state.clearSearchHistory }));
vi.mock('../lib/creation-draft-resume', () => ({ clearCreationDraftsForUser: vi.fn(async () => undefined) }));
vi.mock('../lib/post-composer-draft-resume', () => ({ clearComposerDraftsForUser: vi.fn(async () => undefined) }));
vi.mock('../lib/generation-attempts', () => ({ clearGenerationAttemptForUser: vi.fn(async () => undefined) }));
vi.mock('../lib/apple-auth', () => ({
  authorizeNativeAppleAccountDeletion: vi.fn(),
  signInWithNativeApple: vi.fn(),
}));
vi.mock('../lib/google-auth', () => ({ signInWithGoogleOAuth: state.signInWithGoogleOAuth }));
vi.mock('../lib/referral-attribution', () => ({ claimPendingReferral: vi.fn(async () => undefined) }));
vi.mock('../lib/notifications', () => ({
  clearLocalMobilePushRegistration: vi.fn(async () => undefined),
  registerForMobilePushNotifications: vi.fn(async () => undefined),
  subscribeToMobilePushTokenChanges: vi.fn(() => vi.fn()),
  unregisterMobilePushNotifications: vi.fn(async () => undefined),
}));
vi.mock('../lib/supabase-auth-recovery', () => ({
  isInvalidRefreshTokenError: (error: unknown) => (error as { code?: string } | null)?.code === 'refresh_token_not_found',
  isNetworkRequestFailedError: () => false,
  isRetryableRefreshError: () => false,
  isSessionEndedRefreshError: () => true,
  normalizeSupabaseAuthError: (error: unknown) => error,
}));
vi.mock('../lib/supabase-session-probe', () => ({ probeSupabaseSession: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: vi.fn(async () => undefined),
  duringSignOut: (work: () => Promise<unknown>) => work(),
  initializeSupabaseAuth: vi.fn(async () => undefined),
  isSupabaseConfigured: true,
  readPersistedSupabaseSession: vi.fn(async () => null),
  supabase: {
    auth: {
      getSession: state.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        state.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      refreshSession: vi.fn(),
      signInAnonymously: state.signInAnonymously,
      signInWithPassword: state.signInWithPassword,
      signOut: state.signOut,
      startAutoRefresh: vi.fn(async () => undefined),
      stopAutoRefresh: vi.fn(async () => undefined),
      updateUser: state.updateUser,
    },
  },
}));

import { signInWithNativeApple } from '../lib/apple-auth';
import {
  AuthProvider,
  GUEST_BOOTSTRAP_RETRY_DELAYS_MS,
  guestBootstrapRetryDelayMs,
  isIdentityDeferredOnAccount,
  useAuth,
} from '../lib/auth';
import {
  bindGuestMergeTicket,
  readGuestMergeOutcome,
  readGuestMergeTickets,
  storeGuestMergeOutcome,
  storeGuestMergeTicket,
} from '../lib/guest-merge-ticket-storage';
import { supabase } from '../lib/supabase';
import { cachedVideoStill, cacheVideoStill } from '../lib/video-still-cache';

const OLD_GUEST_TICKET = 'a'.repeat(64);
const GUEST_TICKET = 'b'.repeat(64);

function sessionFor(user: Record<string, unknown>, accessToken = 'access-token', expiresInSeconds = 3600) {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    token_type: 'bearer',
    user,
  };
}

const guestSession = () => sessionFor({ id: 'guest-1', is_anonymous: true }, 'guest-token');
const accountA = () => sessionFor({ id: 'account-a', email: 'a@example.com' }, 'account-a-token');
const accountB = () => sessionFor({ id: 'account-b', email: 'b@example.com' }, 'account-b-token');

function inDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const offline = { data: { session: null }, error: new Error('Network request failed') };

async function flush() {
  await renderer.act(async () => {
    for (let tick = 0; tick < 60; tick += 1) await Promise.resolve();
  });
}

/** Moves the fake clock, running what comes due and what it starts. */
async function advance(ms: number) {
  await renderer.act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let tick = 0; tick < 60; tick += 1) await Promise.resolve();
  });
}

/** The app comes back to the foreground. */
async function foreground() {
  await renderer.act(async () => {
    for (const listener of [...state.appStateListeners]) listener('active');
  });
  await flush();
}

function emitCacheEvent(event: CacheEvent) {
  renderer.act(() => {
    for (const listener of [...state.cacheListeners]) listener(event);
  });
}

/**
 * Mounts the provider. `session` is what auth-js answers with from here on;
 * leave it out to keep answers the test has queued.
 */
async function mount(session?: unknown) {
  if (session !== undefined) state.getSession.mockResolvedValue({ data: { session }, error: null });
  const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
  function Probe() {
    latest.current = useAuth();
    return null;
  }
  let tree: renderer.ReactTestRenderer | undefined;
  await renderer.act(async () => {
    tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
  });
  await flush();
  return { latest, unmount: () => renderer.act(() => tree?.unmount()) };
}

/** Mounts the provider inside an <Activity>, which can hide it and show it again. */
async function mountInActivity(session: unknown) {
  state.getSession.mockResolvedValue({ data: { session }, error: null });
  const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
  function Probe() {
    latest.current = useAuth();
    return null;
  }
  const inActivity = (mode: 'visible' | 'hidden') => (
    <React.Activity mode={mode}><AuthProvider><Probe /></AuthProvider></React.Activity>
  );
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(inActivity('visible'));
  });
  await flush();
  return {
    latest,
    hide: () => renderer.act(() => tree.update(inActivity('hidden'))),
    show: async () => {
      await renderer.act(async () => {
        tree.update(inActivity('visible'));
      });
      await flush();
    },
    unmount: () => renderer.act(() => tree.unmount()),
  };
}

function profileReads() {
  return state.queryClient.fetchQuery.mock.calls.filter(([options]) => (
    (options as { queryKey: readonly unknown[] }).queryKey[0] === 'profile'
  )).length;
}

/** A password sign-in that lands on `session`, the way auth-js reports it. */
function signInLandsOn(session: ReturnType<typeof sessionFor>) {
  state.signInWithPassword.mockImplementation(async () => {
    state.authCallback?.('SIGNED_IN', session);
    return { data: { session, user: session.user }, error: null };
  });
}

beforeEach(() => {
  state.appStateListeners.clear();
  state.cacheListeners.clear();
  state.secureStore.clear();
  state.authCallback = null;
  state.getAccessToken = null;
  state.balances = {};
  state.platform = 'web';
  state.clearSearchHistory.mockReset().mockResolvedValue(undefined);
  state.deleteAccount.mockReset();
  state.dismissTo.mockReset();
  state.signInWithGoogleOAuth.mockReset();
  vi.mocked(signInWithNativeApple).mockReset();
  state.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  state.queryClient.fetchQuery.mockReset().mockImplementation(async ({ queryKey }: { queryKey: readonly unknown[] }) => (
    { credits: state.balances[String(queryKey[1])] ?? 0 }
  ));
  state.queryClient.clear.mockReset();
  state.queryClient.removeQueries.mockReset();
  state.mergeGuestAccount.mockReset();
  state.prepareGuestAccountMerge.mockReset().mockResolvedValue({ ticket: GUEST_TICKET, expiresAt: inDays(30) });
  state.replace.mockReset();
  state.signInAnonymously.mockReset().mockResolvedValue({ data: { session: guestSession() }, error: null });
  state.signInWithPassword.mockReset();
  state.signOut.mockReset().mockResolvedValue({ error: null });
  state.updateUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a guest bootstrap that failed (audit 02-6)', () => {
  it('backs off 5 s, 30 s, 2 min, then every 5 min', () => {
    expect(GUEST_BOOTSTRAP_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 300_000]);
    expect([1, 2, 3, 4, 5, 12].map(guestBootstrapRetryDelayMs))
      .toEqual([5_000, 30_000, 120_000, 300_000, 300_000, 300_000]);
  });

  it('is tried again after each wait, and no more once a guest has landed', async () => {
    vi.useFakeTimers();
    state.signInAnonymously.mockResolvedValue(offline);
    const { latest, unmount } = await mount(null);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(latest.current?.identityUserId).toBeNull();

    const waits = [5_000, 30_000, 120_000, 300_000, 300_000];
    for (const [index, wait] of waits.entries()) {
      await advance(wait - 1);
      expect(state.signInAnonymously).toHaveBeenCalledTimes(index + 1);
      await advance(1);
      expect(state.signInAnonymously).toHaveBeenCalledTimes(index + 2);
    }

    state.signInAnonymously.mockResolvedValue({ data: { session: guestSession() }, error: null });
    await advance(300_000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(7);
    expect(latest.current?.identityUserId).toBe('guest-1');

    await advance(60 * 60 * 1000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(7);
    unmount();
  });

  it('is tried again at once when the app comes back, and the backoff carries on from there', async () => {
    vi.useFakeTimers();
    state.signInAnonymously.mockResolvedValue(offline);
    const { unmount } = await mount(null);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    await advance(1_000);
    await foreground();
    expect(state.signInAnonymously).toHaveBeenCalledTimes(2);

    // Two failures in a row: the next wait is 30 s, counted from the return.
    await advance(29_999);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('is started by a request that finds no session, never more often than the backoff allows', async () => {
    vi.useFakeTimers();
    // A guest whose access token has run out, so a request asks auth-js.
    const expiring = sessionFor({ id: 'guest-1', is_anonymous: true }, 'guest-token', -60);
    const { latest, unmount } = await mount(expiring);
    expect(latest.current?.identityUserId).toBe('guest-1');
    expect(state.signInAnonymously).not.toHaveBeenCalled();

    // auth-js could not refresh the session and dropped it.
    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    state.signInAnonymously.mockResolvedValue(offline);
    let token: string | null | undefined = 'unset';
    await renderer.act(async () => {
      token = await state.getAccessToken?.();
    });
    await flush();
    expect(token).toBeNull();
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      await Promise.all([state.getAccessToken?.(), state.getAccessToken?.(), state.getAccessToken?.()]);
    });
    await flush();
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    state.signInAnonymously.mockResolvedValue({
      data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }, 'guest-2-token') },
      error: null,
    });
    await advance(5_000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(2);
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });

  it('starts a guest when the stored session was refused at launch', async () => {
    state.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'), { code: 'refresh_token_not_found' }),
    });
    const { latest, unmount } = await mount();

    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(latest.current?.identityUserId).toBe('guest-1');
    unmount();
  });

  it('lets a bootstrap under way finish before a sign-in starts, so its guest is the one carried across', async () => {
    let landGuest: (value: unknown) => void = () => undefined;
    state.signInAnonymously.mockImplementation(() => new Promise((resolve) => {
      landGuest = resolve;
    }));
    const account = accountA();
    signInLandsOn(account);
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 0, promotionalCreditsMoved: 0, credits: 0 });
    const { latest, unmount } = await mount(null);

    let signIn: Promise<void> | undefined;
    await renderer.act(async () => {
      signIn = latest.current?.signInWithPassword('a@example.com', 'correct-Horse-1');
    });
    await flush();
    expect(state.signInWithPassword).not.toHaveBeenCalled();

    await renderer.act(async () => {
      landGuest({ data: { session: guestSession() }, error: null });
      await signIn;
    });
    await flush();

    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();
    expect(state.signInWithPassword).toHaveBeenCalledOnce();
    expect(state.mergeGuestAccount).toHaveBeenCalledWith(GUEST_TICKET);
    expect(latest.current?.user?.id).toBe('account-a');
    unmount();
  });

  it('starts no guest while a sign-in is under way', async () => {
    vi.useFakeTimers();
    state.signInAnonymously.mockResolvedValue(offline);
    const account = accountA();
    let finishSignIn: () => void = () => undefined;
    state.signInWithPassword.mockImplementation(() => new Promise((resolve) => {
      finishSignIn = () => {
        state.authCallback?.('SIGNED_IN', account);
        resolve({ data: { session: account, user: account.user }, error: null });
      };
    }));
    const { latest, unmount } = await mount(null);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    let signIn: Promise<void> | undefined;
    await renderer.act(async () => {
      signIn = latest.current?.signInWithPassword('a@example.com', 'correct-Horse-1');
    });
    await flush();
    // The retry comes due while the sign-in is out.
    await advance(5_000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      finishSignIn();
      await signIn;
    });
    await advance(60 * 60 * 1000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(latest.current?.user?.id).toBe('account-a');
    unmount();
  });

  // An <Activity> hidden and shown again runs every effect once more over kept state.
  it('waits while the provider is hidden, and takes up a retry that came due once it is shown', async () => {
    vi.useFakeTimers();
    state.signInAnonymously.mockResolvedValue(offline);
    const provider = await mountInActivity(null);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    provider.hide();
    await advance(10_000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);

    await provider.show();
    expect(state.signInAnonymously).toHaveBeenCalledTimes(2);

    // The backoff carries on from there: two failures, so 30 s.
    await advance(29_999);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(3);
    provider.unmount();
  });

  it('stops once the provider is gone', async () => {
    vi.useFakeTimers();
    state.signInAnonymously.mockResolvedValue(offline);
    const { unmount } = await mount(null);
    unmount();

    await advance(60 * 60 * 1000);
    expect(state.signInAnonymously).toHaveBeenCalledTimes(1);
  });
});

describe('guest merge tickets (audit 02-7, 04-8)', () => {
  it('keeps a ticket for a guest from the moment it holds credits, and mints it once', async () => {
    state.balances['guest-1'] = 120;
    const { latest, unmount } = await mount(guestSession());

    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();
    await expect(readGuestMergeTickets()).resolves.toEqual([
      { ticket: GUEST_TICKET, guestUserId: 'guest-1', redeemedForUserId: null, expiresAt: expect.any(String) },
    ]);

    // A purchase or a first creation asks again, and finds it kept.
    await renderer.act(async () => {
      await latest.current?.ensureGuestMergeTicket();
    });
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();
    unmount();
  });

  it('mints none for a guest without credits, nor for an account', async () => {
    const guest = await mount(guestSession());
    expect(state.prepareGuestAccountMerge).not.toHaveBeenCalled();
    guest.unmount();

    state.balances['account-a'] = 500;
    const account = await mount(accountA());
    await renderer.act(async () => {
      await account.latest.current?.ensureGuestMergeTicket();
    });
    expect(state.prepareGuestAccountMerge).not.toHaveBeenCalled();
    account.unmount();
  });

  it('never rejects when the ticket cannot be minted, and tries again on the way back', async () => {
    state.balances['guest-1'] = 120;
    state.prepareGuestAccountMerge.mockRejectedValue(new Error('Network request failed'));
    const { latest, unmount } = await mount(guestSession());
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      await expect(latest.current?.ensureGuestMergeTicket()).resolves.toBeUndefined();
    });
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledTimes(2);

    state.prepareGuestAccountMerge.mockResolvedValue({ ticket: GUEST_TICKET, expiresAt: inDays(30) });
    await foreground();
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledTimes(3);
    await expect(readGuestMergeTickets()).resolves.toHaveLength(1);
    unmount();
  });

  it('lets a ticket mint under way finish before a sign-in starts', async () => {
    state.balances['guest-1'] = 120;
    let mintFirst: (value: unknown) => void = () => undefined;
    state.prepareGuestAccountMerge
      .mockImplementationOnce(() => new Promise((resolve) => {
        mintFirst = resolve;
      }))
      .mockResolvedValueOnce({ ticket: GUEST_TICKET, expiresAt: inDays(30) });
    signInLandsOn(accountA());
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 120, promotionalCreditsMoved: 0, credits: 120 });
    const { latest, unmount } = await mount(guestSession());
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();

    let signIn: Promise<void> | undefined;
    await renderer.act(async () => {
      signIn = latest.current?.signInWithPassword('a@example.com', 'correct-Horse-1');
    });
    await flush();
    expect(state.signInWithPassword).not.toHaveBeenCalled();

    await renderer.act(async () => {
      mintFirst({ ticket: OLD_GUEST_TICKET, expiresAt: inDays(30) });
      await signIn;
    });
    await flush();

    // The sign-in's own ticket replaced the one minted just before it.
    expect(state.signInWithPassword).toHaveBeenCalledOnce();
    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();
    expect(state.mergeGuestAccount).toHaveBeenCalledWith(GUEST_TICKET);
    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    unmount();
  });

  it("redeems two guests' tickets for the account that signs in, each once", async () => {
    // A guest whose session ended after it bought credits left its ticket.
    await storeGuestMergeTicket({ guestUserId: 'guest-old', ticket: OLD_GUEST_TICKET, expiresAt: inDays(20) });
    const account = accountA();
    signInLandsOn(account);
    state.balances['account-a'] = 350;
    state.mergeGuestAccount.mockImplementation(async (ticket: string) => (ticket === OLD_GUEST_TICKET
      ? { status: 'merged', creditsMoved: 300, promotionalCreditsMoved: 0, credits: 300 }
      : { status: 'merged', creditsMoved: 50, promotionalCreditsMoved: 0, credits: 350 }));
    const { latest, unmount } = await mount(guestSession());

    await renderer.act(async () => {
      await latest.current?.signInWithPassword('a@example.com', 'correct-Horse-1');
    });
    await flush();

    // The sign-in's own redemption and the launch retry beside it are one run.
    expect(state.mergeGuestAccount).toHaveBeenCalledTimes(2);
    expect(state.mergeGuestAccount.mock.calls.map(([ticket]) => ticket).sort()).toEqual([OLD_GUEST_TICKET, GUEST_TICKET]);
    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    expect(latest.current?.mergeState).toBe('idle');
    expect(latest.current?.guestMergeOutcome).toEqual({ status: 'merged', creditsMoved: 350, at: expect.any(Number) });
    expect(latest.current?.credits).toBe(350);
    unmount();
  });

  it('never sends a ticket recorded for account A when account B signs in on the same phone', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-a', ticket: OLD_GUEST_TICKET, expiresAt: inDays(20) });
    await bindGuestMergeTicket(OLD_GUEST_TICKET, 'account-a');
    await storeGuestMergeTicket({ guestUserId: 'guest-b', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 0, promotionalCreditsMoved: 0, credits: 0 });

    const { unmount } = await mount(accountB());

    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();
    expect(state.mergeGuestAccount).toHaveBeenCalledWith(GUEST_TICKET);
    await expect(readGuestMergeTickets()).resolves.toEqual([
      { ticket: OLD_GUEST_TICKET, guestUserId: 'guest-a', redeemedForUserId: 'account-a', expiresAt: expect.any(String) },
    ]);
    unmount();
  });

  it('keeps a ticket whose redemption keeps failing, recorded for its account, and sends it again on the way back', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockRejectedValue(new Error('Network request failed'));
    const { latest, unmount } = await mount(accountA());

    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();
    await expect(readGuestMergeTickets()).resolves.toEqual([
      { ticket: GUEST_TICKET, guestUserId: 'guest-1', redeemedForUserId: 'account-a', expiresAt: expect.any(String) },
    ]);
    expect(latest.current?.mergeState).toBe('pending');
    expect(latest.current?.guestMergeOutcome).toBeNull();

    await foreground();
    expect(state.mergeGuestAccount).toHaveBeenCalledTimes(2);
    await expect(readGuestMergeTickets()).resolves.toHaveLength(1);
    unmount();
  });

  it('sends a ticket once when the app comes back while its redemption is still out', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    let answer: (value: unknown) => void = () => undefined;
    state.mergeGuestAccount.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const { latest, unmount } = await mount(accountA());
    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();

    await foreground();
    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      answer({ status: 'merged', creditsMoved: 40, promotionalCreditsMoved: 0, credits: 40 });
    });
    await flush();
    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    expect(latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 40 });
    unmount();
  });

  it('sends a ticket once when the provider is hidden and shown again while it is out', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    let answer: (value: unknown) => void = () => undefined;
    state.mergeGuestAccount.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const provider = await mountInActivity(accountA());
    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();

    provider.hide();
    await provider.show();
    expect(state.mergeGuestAccount).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      answer({ status: 'merged', creditsMoved: 40, promotionalCreditsMoved: 0, credits: 40 });
    });
    await flush();
    expect(provider.latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 40 });
    provider.unmount();
  });

  it('keeps the tickets through a sign-out', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockRejectedValue(new Error('Network request failed'));
    const { latest, unmount } = await mount(accountA());

    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await renderer.act(async () => {
      await latest.current?.signOut();
    });
    await flush();

    expect(latest.current?.user).toBeNull();
    await expect(readGuestMergeTickets()).resolves.toEqual([
      expect.objectContaining({ ticket: GUEST_TICKET, redeemedForUserId: 'account-a' }),
    ]);
    unmount();
  });

  it('lets go of the clip stills read on this phone with a sign-out', async () => {
    cacheVideoStill('generation_inputs/account-a/clip.mp4', { width: 405, height: 720 } as never);
    const { latest, unmount } = await mount(accountA());

    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await renderer.act(async () => {
      await latest.current?.signOut();
    });
    await flush();

    expect(latest.current?.user).toBeNull();
    expect(cachedVideoStill('generation_inputs/account-a/clip.mp4')).toBeUndefined();
    unmount();
  });

  it('signs in on the ticket kept since the guest held credits when a fresh one cannot be minted', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: OLD_GUEST_TICKET, expiresAt: inDays(20) });
    state.prepareGuestAccountMerge.mockRejectedValue(new Error('Too many requests'));
    signInLandsOn(accountA());
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 120, promotionalCreditsMoved: 0, credits: 120 });
    const { latest, unmount } = await mount(guestSession());

    await renderer.act(async () => {
      await latest.current?.signInWithPassword('a@example.com', 'correct-Horse-1');
    });
    await flush();

    expect(state.signInWithPassword).toHaveBeenCalledOnce();
    expect(state.mergeGuestAccount).toHaveBeenCalledWith(OLD_GUEST_TICKET);
    expect(latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 120 });
    unmount();
  });
});

describe('what the links came to (audit 02-8)', () => {
  it('keeps a success, with the credits it moved, through a restart until it is dismissed', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 250, promotionalCreditsMoved: 0, credits: 250 });

    const first = await mount(accountA());
    expect(first.latest.current?.guestMergeOutcome).toEqual({ status: 'merged', creditsMoved: 250, at: expect.any(Number) });
    first.unmount();

    const second = await mount(accountA());
    expect(second.latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 250 });
    renderer.act(() => second.latest.current?.dismissGuestMergeOutcome());
    await flush();
    expect(second.latest.current?.guestMergeOutcome).toBeNull();
    second.unmount();

    const third = await mount(accountA());
    expect(third.latest.current?.guestMergeOutcome).toBeNull();
    third.unmount();
  });

  it('tells a conflict, and only ever to the account it happened to', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockResolvedValue({ status: 'conflict', creditsMoved: 0, promotionalCreditsMoved: 0, credits: null });

    const first = await mount(accountA());
    expect(first.latest.current?.guestMergeOutcome).toEqual({ status: 'conflict', creditsMoved: 0, at: expect.any(Number) });
    expect(first.latest.current?.mergeState).toBe('failed');
    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    first.unmount();

    const other = await mount(accountB());
    expect(other.latest.current?.guestMergeOutcome).toBeNull();
    other.unmount();
  });

  it('tells a link the server keeps refusing, while the ticket waits for the next try', async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.mergeGuestAccount.mockResolvedValue({ status: 'not_eligible', creditsMoved: 0, promotionalCreditsMoved: 0, credits: null });

    const { latest, unmount } = await mount(accountA());
    expect(latest.current?.guestMergeOutcome).toMatchObject({ status: 'not_eligible' });
    await expect(readGuestMergeTickets()).resolves.toHaveLength(1);

    // The next try lands: what is shown becomes the credits that arrived.
    state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 80, promotionalCreditsMoved: 0, credits: 80 });
    await foreground();
    expect(latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 80 });
    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    unmount();
  });
});

describe('the balance (audit 03-4)', () => {
  it('is read again when the app comes back, at most every 30 s', async () => {
    vi.useFakeTimers();
    state.balances['account-a'] = 100;
    const { latest, unmount } = await mount(accountA());
    expect(profileReads()).toBe(1);
    expect(latest.current?.credits).toBe(100);
    expect(latest.current?.creditsUpdatedAt).toBe(Date.now());

    // Bought on the web while the app was away.
    state.balances['account-a'] = 600;
    await advance(10_000);
    await foreground();
    expect(profileReads()).toBe(1);

    await advance(20_000);
    await foreground();
    expect(profileReads()).toBe(2);
    expect(latest.current?.credits).toBe(600);
    expect(latest.current?.creditsUpdatedAt).toBe(Date.now());

    await foreground();
    expect(profileReads()).toBe(2);
    unmount();
  });

  it("is read again for a guest too, whose credits are bought the same way", async () => {
    vi.useFakeTimers();
    const { unmount } = await mount(guestSession());
    expect(profileReads()).toBe(1);

    await advance(30_000);
    await foreground();
    expect(profileReads()).toBe(2);
    unmount();
  });

  it('follows a profile read made anywhere, never a value written into the cache by hand', async () => {
    const { latest, unmount } = await mount(accountA());
    const read = (data: unknown, key: readonly unknown[] = ['profile', 'account-a'], manual?: boolean): CacheEvent => ({
      type: 'updated',
      action: { type: 'success', manual },
      query: { queryKey: key, state: { data, dataUpdatedAt: 1_700_000_000_000 } },
    });

    emitCacheEvent(read({ credits: 900 }));
    expect(latest.current?.credits).toBe(900);
    expect(latest.current?.creditsUpdatedAt).toBe(1_700_000_000_000);

    emitCacheEvent(read({ credits: 5 }, ['profile', 'account-a'], true));
    emitCacheEvent(read({ credits: 6 }, ['profile', 'account-b']));
    emitCacheEvent(read({ credits: 7 }, ['notification-badge', 'account-a']));
    expect(latest.current?.credits).toBe(900);
    unmount();
  });

  it('keeps a balance this app moved itself over a read that set out before it', async () => {
    const { latest, unmount } = await mount(accountA());
    const event = (type: string, credits?: number): CacheEvent => ({
      type: 'updated',
      action: { type },
      query: { queryKey: ['profile', 'account-a'], state: { data: { credits }, dataUpdatedAt: Date.now() } },
    });

    // Home starts a read; a generation answers with the balance after its spend.
    emitCacheEvent(event('fetch'));
    renderer.act(() => latest.current?.updateCredits(42));
    emitCacheEvent(event('success', 900));
    expect(latest.current?.credits).toBe(42);

    // A read that set out afterwards is the newer.
    emitCacheEvent(event('fetch'));
    emitCacheEvent(event('success', 950));
    expect(latest.current?.credits).toBe(950);

    // The same holds for a refresh made here.
    let answer: (value: unknown) => void = () => undefined;
    state.queryClient.fetchQuery.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve;
    }));
    let refresh: Promise<void> | undefined;
    await renderer.act(async () => {
      refresh = latest.current?.refreshProfile();
    });
    renderer.act(() => latest.current?.updateCredits(30));
    await renderer.act(async () => {
      answer({ credits: 950 });
      await refresh;
    });
    expect(latest.current?.credits).toBe(30);
    unmount();
  });

  it('dates a balance this app moved itself', async () => {
    vi.useFakeTimers();
    const { latest, unmount } = await mount(accountA());
    await advance(1_000);

    renderer.act(() => latest.current?.updateCredits(42));
    expect(latest.current?.credits).toBe(42);
    expect(latest.current?.creditsUpdatedAt).toBe(Date.now());
    unmount();
  });
});

// Welcome and referral credits are in the balance, but the credit unlock will
// not spend them (02-1): the recipe screens read this figure, not the total.
describe('the part of the balance that can buy creator resources', () => {
  const profileRead = (data: unknown, type = 'success'): CacheEvent => ({
    type: 'updated',
    action: { type },
    query: { queryKey: ['profile', 'account-a'], state: { data, dataUpdatedAt: Date.now() } },
  });

  it('settles with the balance from any profile read, and moves with updateCredits', async () => {
    state.queryClient.fetchQuery.mockImplementation(async () => (
      { credits: 1200, promotionalCredits: 1200, marketplaceSpendableCredits: 0 }
    ));
    const { latest, unmount } = await mount(accountA());
    expect(latest.current?.credits).toBe(1200);
    expect(latest.current?.marketplaceSpendableCredits).toBe(0);

    emitCacheEvent(profileRead({ credits: 1500, promotionalCredits: 300, marketplaceSpendableCredits: 1200 }));
    expect(latest.current?.marketplaceSpendableCredits).toBe(1200);

    // A generation's spend: only the total is known, and the database took it
    // from the promotional credits first, so the spendable part stands.
    renderer.act(() => latest.current?.updateCredits(1400));
    expect(latest.current?.credits).toBe(1400);
    expect(latest.current?.marketplaceSpendableCredits).toBe(1200);

    // The welcome grant: a rise the server did not split is not spendable.
    renderer.act(() => latest.current?.updateCredits(1700));
    expect(latest.current?.credits).toBe(1700);
    expect(latest.current?.marketplaceSpendableCredits).toBe(1200);

    // A spend that takes the total below the spendable part lowers it.
    renderer.act(() => latest.current?.updateCredits(900));
    expect(latest.current?.credits).toBe(900);
    expect(latest.current?.marketplaceSpendableCredits).toBe(900);

    // A recipe unlock answers the figure itself.
    renderer.act(() => latest.current?.updateCredits(800, { marketplaceSpendableCredits: 200 }));
    expect(latest.current?.credits).toBe(800);
    expect(latest.current?.marketplaceSpendableCredits).toBe(200);

    // A total moved past an unknown split leaves it unknown.
    emitCacheEvent(profileRead(undefined, 'fetch'));
    emitCacheEvent(profileRead({ credits: 900 }));
    expect(latest.current?.credits).toBe(900);
    expect(latest.current?.marketplaceSpendableCredits).toBeNull();
    renderer.act(() => latest.current?.updateCredits(850));
    expect(latest.current?.marketplaceSpendableCredits).toBeNull();
    unmount();
  });

  it("counts a linked guest's purchased credits as spendable, never its promotional ones", async () => {
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    state.queryClient.fetchQuery.mockImplementation(async () => (
      { credits: 100, promotionalCredits: 40, marketplaceSpendableCredits: 60 }
    ));
    let finishMerge: (value: unknown) => void = () => undefined;
    state.mergeGuestAccount.mockImplementation(() => new Promise((resolve) => {
      finishMerge = resolve;
    }));

    const { latest, unmount } = await mount(accountA());
    expect(state.mergeGuestAccount).toHaveBeenCalledWith(GUEST_TICKET);
    expect(latest.current?.marketplaceSpendableCredits).toBe(60);

    await renderer.act(async () => {
      finishMerge({ status: 'merged', creditsMoved: 250, promotionalCreditsMoved: 50, credits: 350 });
    });
    await flush();
    expect(latest.current?.credits).toBe(350);
    expect(latest.current?.marketplaceSpendableCredits).toBe(260);
    unmount();
  });

  it('forgets it with the balance when the account changes', async () => {
    state.queryClient.fetchQuery.mockImplementation(async ({ queryKey }: { queryKey: readonly unknown[] }) => (
      queryKey[1] === 'account-a'
        ? { credits: 500, marketplaceSpendableCredits: 500 }
        : new Promise(() => undefined)
    ));
    const { latest, unmount } = await mount(accountA());
    expect(latest.current?.marketplaceSpendableCredits).toBe(500);

    await renderer.act(async () => {
      state.authCallback?.('SIGNED_IN', accountB());
    });
    await flush();
    expect(latest.current?.user?.id).toBe('account-b');
    expect(latest.current?.credits).toBeNull();
    expect(latest.current?.marketplaceSpendableCredits).toBeNull();
    unmount();
  });
});

describe('"Set up later" on the account (audit 02-11)', () => {
  it("writes the web's key and version for an account", async () => {
    const { latest, unmount } = await mount(accountA());

    await renderer.act(async () => {
      await latest.current?.markIdentityDeferredOnAccount();
    });

    expect(state.updateUser).toHaveBeenCalledWith({ data: { creator_profile_onboarding_skipped_version: 1 } });
    unmount();
  });

  it('writes nothing for a guest, or for an account that has it on record already', async () => {
    const guest = await mount(guestSession());
    await renderer.act(async () => {
      await guest.latest.current?.markIdentityDeferredOnAccount();
    });
    guest.unmount();

    const deferred = sessionFor({
      id: 'account-a',
      email: 'a@example.com',
      user_metadata: { creator_profile_onboarding_skipped_version: 1 },
    });
    const account = await mount(deferred);
    await renderer.act(async () => {
      await account.latest.current?.markIdentityDeferredOnAccount();
    });
    account.unmount();

    expect(state.updateUser).not.toHaveBeenCalled();
  });

  it('never rejects when the account cannot be written', async () => {
    const { latest, unmount } = await mount(accountA());

    state.updateUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('Network request failed') });
    await renderer.act(async () => {
      await expect(latest.current?.markIdentityDeferredOnAccount()).resolves.toBeUndefined();
    });
    state.updateUser.mockRejectedValueOnce(new Error('Aborted'));
    await renderer.act(async () => {
      await expect(latest.current?.markIdentityDeferredOnAccount()).resolves.toBeUndefined();
    });
    unmount();
  });

  it('reads the record the way the web does', () => {
    const userWith = (metadata: unknown) => ({ user_metadata: metadata as Record<string, unknown> });

    expect(isIdentityDeferredOnAccount(userWith({ creator_profile_onboarding_skipped_version: 1 }))).toBe(true);
    expect(isIdentityDeferredOnAccount(userWith({ creator_profile_onboarding_skipped_version: 2 }))).toBe(true);
    expect(isIdentityDeferredOnAccount(userWith({ creator_profile_onboarding_skipped_version: '1' }))).toBe(false);
    expect(isIdentityDeferredOnAccount(userWith({ creator_profile_onboarding_skipped_version: 0 }))).toBe(false);
    expect(isIdentityDeferredOnAccount(userWith({}))).toBe(false);
    expect(isIdentityDeferredOnAccount(null)).toBe(false);
  });
});

// D1: Google was refused on iOS before anything was asked, so an account made
// with Google on the web or on Android could not be reached from an iPhone.
describe('Google on iPhone (D1)', () => {
  /** A Google sign-in that comes back on `session`, the way auth-js reports the code exchange. */
  function googleLandsOn(session: ReturnType<typeof sessionFor>) {
    state.signInWithGoogleOAuth.mockImplementation(async () => {
      state.authCallback?.('SIGNED_IN', session);
    });
  }

  it.each(['ios', 'android'] as const)(
    "signs in through Supabase's OAuth on %s, the guest's credits kept for the account first",
    async (os) => {
      state.platform = os;
      googleLandsOn(accountA());
      state.mergeGuestAccount.mockResolvedValue({ status: 'merged', creditsMoved: 120, promotionalCreditsMoved: 0, credits: 120 });
      const { latest, unmount } = await mount(guestSession());

      await renderer.act(async () => {
        await latest.current?.signInWithGoogle();
      });
      await flush();

      expect(state.signInWithGoogleOAuth).toHaveBeenCalledOnce();
      expect(state.signInWithGoogleOAuth).toHaveBeenCalledWith(supabase);
      // The ticket that carries the guest's credits is kept before the browser
      // hands the device an account's session.
      expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();
      expect(state.prepareGuestAccountMerge.mock.invocationCallOrder[0])
        .toBeLessThan(state.signInWithGoogleOAuth.mock.invocationCallOrder[0]);
      expect(state.mergeGuestAccount).toHaveBeenCalledWith(GUEST_TICKET);
      expect(latest.current?.user?.id).toBe('account-a');
      expect(latest.current?.guestMergeOutcome).toMatchObject({ status: 'merged', creditsMoved: 120 });
      unmount();
    },
  );

  it('keeps the guest, and its ticket, when the Google sheet is closed on an iPhone', async () => {
    state.platform = 'ios';
    const canceled = Object.assign(new Error('Google sign-in was canceled.'), { code: 'ERR_GOOGLE_AUTH_CANCELED' });
    state.signInWithGoogleOAuth.mockRejectedValue(canceled);
    const { latest, unmount } = await mount(guestSession());

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.signInWithGoogle().catch((thrown: unknown) => {
        failure = thrown;
      });
    });
    await flush();

    expect(failure).toBe(canceled);
    expect(latest.current?.isGuest).toBe(true);
    expect(latest.current?.identityUserId).toBe('guest-1');
    expect(state.mergeGuestAccount).not.toHaveBeenCalled();
    await expect(readGuestMergeTickets()).resolves.toEqual([
      expect.objectContaining({ ticket: GUEST_TICKET, guestUserId: 'guest-1', redeemedForUserId: null }),
    ]);
    unmount();
  });

  // The platform switch is live here: Apple, native to iOS, still refuses
  // Android before anything is asked.
  it('leaves Apple to iOS', async () => {
    state.platform = 'android';
    const { latest, unmount } = await mount(guestSession());

    await renderer.act(async () => {
      await expect(latest.current?.signInWithApple('login')).rejects.toThrow('Apple sign-in is available on iOS only.');
    });

    expect(signInWithNativeApple).not.toHaveBeenCalled();
    expect(state.prepareGuestAccountMerge).not.toHaveBeenCalled();
    unmount();
  });
});

// D5: a guest deletes itself and what it made. The credits a ticket kept for it
// would carry went with it; every other ticket on the phone is someone's credits.
describe("a guest's deletion and the tickets on this phone (D5)", () => {
  const THIRD_TICKET = 'c'.repeat(64);

  /** Mounts the guest. Past mount, auth-js answers with no session, as once a deletion has cleared it. */
  async function mountGuestToDelete() {
    const mounted = await mount(guestSession());
    state.getSession.mockResolvedValue({ data: { session: null }, error: null });
    state.signInAnonymously.mockResolvedValue({
      data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }, 'guest-2-token') },
      error: null,
    });
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    return mounted;
  }

  it("forgets the tickets kept for that guest only, and what an account's links came to stays", async () => {
    // A guest whose session ended after it bought credits, waiting for the next sign-in here.
    await storeGuestMergeTicket({ guestUserId: 'guest-old', ticket: OLD_GUEST_TICKET, expiresAt: inDays(20) });
    // Kept for this guest since it bought credits.
    await storeGuestMergeTicket({ guestUserId: 'guest-1', ticket: GUEST_TICKET, expiresAt: inDays(30) });
    // Sent for account A, its redemption not settled yet.
    await storeGuestMergeTicket({ guestUserId: 'guest-a', ticket: THIRD_TICKET, expiresAt: inDays(30) });
    await bindGuestMergeTicket(THIRD_TICKET, 'account-a');
    const accountOutcome = { accountUserId: 'account-a', status: 'merged' as const, creditsMoved: 50, at: Date.now() };
    await storeGuestMergeOutcome(accountOutcome);
    state.balances['guest-1'] = 120;
    const { latest, unmount } = await mountGuestToDelete();
    expect(state.prepareGuestAccountMerge).not.toHaveBeenCalled();

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('scheduled');
    expect(state.deleteAccount).toHaveBeenCalledWith('DELETE', {});
    expect(state.dismissTo).toHaveBeenCalledWith('/');
    expect(latest.current?.identityUserId).toBe('guest-2');
    await expect(readGuestMergeTickets()).resolves.toEqual([
      { ticket: OLD_GUEST_TICKET, guestUserId: 'guest-old', redeemedForUserId: null, expiresAt: expect.any(String) },
      { ticket: THIRD_TICKET, guestUserId: 'guest-a', redeemedForUserId: 'account-a', expiresAt: expect.any(String) },
    ]);
    await expect(readGuestMergeOutcome()).resolves.toEqual(accountOutcome);
    unmount();
  });

  it('keeps nothing from a ticket mint for the guest that lands while its deletion is ending the session', async () => {
    state.balances['guest-1'] = 120;
    let mint: (value: unknown) => void = () => undefined;
    state.prepareGuestAccountMerge.mockImplementationOnce(() => new Promise((resolve) => {
      mint = resolve;
    }));
    const { latest, unmount } = await mountGuestToDelete();
    expect(state.prepareGuestAccountMerge).toHaveBeenCalledOnce();
    // The teardown waits on the device's stores, and the mint answers
    // meanwhile, while the guest's session is still the one in hand.
    let storesCleared: () => void = () => undefined;
    state.clearSearchHistory.mockImplementationOnce(() => new Promise<void>((resolve) => {
      storesCleared = resolve;
    }));

    let deletion: Promise<unknown> | undefined;
    await renderer.act(async () => {
      deletion = latest.current?.deleteAccount();
    });
    await flush();
    expect(state.clearSearchHistory).toHaveBeenCalledOnce();
    await renderer.act(async () => {
      mint({ ticket: GUEST_TICKET, expiresAt: inDays(30) });
    });
    await flush();
    await expect(readGuestMergeTickets()).resolves.toEqual([
      expect.objectContaining({ ticket: GUEST_TICKET, guestUserId: 'guest-1' }),
    ]);

    await renderer.act(async () => {
      storesCleared();
      await deletion;
    });
    await flush();

    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });

  it('keeps nothing from one that lands after it', async () => {
    state.balances['guest-1'] = 120;
    let mint: (value: unknown) => void = () => undefined;
    state.prepareGuestAccountMerge.mockImplementationOnce(() => new Promise((resolve) => {
      mint = resolve;
    }));
    const { latest, unmount } = await mountGuestToDelete();

    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();
    await renderer.act(async () => {
      mint({ ticket: GUEST_TICKET, expiresAt: inDays(30) });
    });
    await flush();

    await expect(readGuestMergeTickets()).resolves.toEqual([]);
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });
});

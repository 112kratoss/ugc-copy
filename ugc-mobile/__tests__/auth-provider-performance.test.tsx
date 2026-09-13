// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  clearLocalPush: vi.fn(),
  clearPersistedHomeFeed: vi.fn(),
  clearPersistedSession: vi.fn(),
  deleteAccount: vi.fn(),
  duringSignOut: vi.fn(),
  getSession: vi.fn(),
  profileResolve: null as null | ((profile: { credits: number }) => void),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn() },
  readPersistedSession: vi.fn(),
  routerReplace: vi.fn(),
  sessionResolve: null as null | ((result: unknown) => void),
  signOut: vi.fn(),
  startAutoRefresh: vi.fn(),
  stopAutoRefresh: vi.fn(),
  unregisterPush: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => state.queryClient,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.0.0' } },
}));

vi.mock('expo-router', () => ({
  router: { replace: state.routerReplace },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'web' },
}));

vi.mock('../lib/env', () => ({
  env: { apiBaseUrl: 'https://api.example.com', supabaseUrl: 'https://storage.example.com' },
  getMissingMobileEnvKeys: () => [],
}));

vi.mock('../lib/api-client', () => ({
  ApiError: class ApiError extends Error {},
  createApiClient: (options: { getAccessToken: () => Promise<string | null> }) => ({
    deleteAccount: state.deleteAccount,
    getAccessTokenForTest: options.getAccessToken,
    getProfile: vi.fn(),
  }),
}));

vi.mock('../lib/feed-installation-id', () => ({ getFeedInstallationId: vi.fn() }));
vi.mock('../lib/feed-event-queue', () => ({
  beginShowcaseFeedEventIdentityTransition: () => ({
    cancel: vi.fn(),
    commit: vi.fn(),
  }),
  configureFeedEventQueue: vi.fn(),
  flushShowcaseFeedEvents: vi.fn(async () => undefined),
  restoreShowcaseFeedEvents: vi.fn(async () => undefined),
}));
vi.mock('../lib/guest-merge-ticket-storage', () => ({
  readGuestMergeTicket: vi.fn(async () => null),
  storeGuestMergeTicket: vi.fn(async () => undefined),
  clearGuestMergeTicket: vi.fn(async () => undefined),
}));
vi.mock('../lib/persisted-home-feed', () => ({ clearPersistedHomeFeed: state.clearPersistedHomeFeed }));
vi.mock('../lib/generation-model-catalog', () => ({ GENERATION_MODEL_CATALOG_SCHEMA_VERSION: 1 }));
vi.mock('../lib/apple-auth', () => ({ signInWithNativeApple: vi.fn() }));
vi.mock('../lib/google-auth', () => ({ signInWithGoogleOAuth: vi.fn() }));
vi.mock('../lib/referral-attribution', () => ({ claimPendingReferral: vi.fn(async () => undefined) }));
vi.mock('../lib/notifications', () => ({
  clearLocalMobilePushRegistration: state.clearLocalPush,
  registerForMobilePushNotifications: vi.fn(async () => undefined),
  subscribeToMobilePushTokenChanges: vi.fn(() => vi.fn()),
  unregisterMobilePushNotifications: state.unregisterPush,
}));
vi.mock('../lib/supabase-auth-recovery', () => ({
  isInvalidRefreshTokenError: () => false,
  isNetworkRequestFailedError: () => false,
  isRetryableRefreshError: (error: unknown) => (error as { name?: string } | null)?.name === 'AuthRetryableFetchError',
  supabaseNetworkFailureMessage: () => 'Network unavailable',
}));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: state.clearPersistedSession,
  duringSignOut: state.duringSignOut,
  initializeSupabaseAuth: vi.fn(async () => undefined),
  isSupabaseConfigured: true,
  readPersistedSupabaseSession: state.readPersistedSession,
  supabase: {
    auth: {
      getSession: state.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        state.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: state.signOut,
      startAutoRefresh: state.startAutoRefresh,
      stopAutoRefresh: state.stopAutoRefresh,
    },
  },
}));

import { AuthProvider, useAuth } from '../lib/auth';

const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'creator@example.com' },
};

describe('AuthProvider startup performance', () => {
  beforeEach(() => {
    state.authCallback = null;
    state.queryClient.fetchQuery.mockReset();
    state.getSession.mockReset();
    state.profileResolve = null;
    state.sessionResolve = null;
    state.getSession.mockImplementation(() => new Promise((resolve) => {
      state.sessionResolve = resolve;
    }));
    state.queryClient.fetchQuery.mockImplementation(() => new Promise((resolve) => {
      state.profileResolve = resolve;
    }));
    state.clearLocalPush.mockReset().mockResolvedValue(undefined);
    state.clearPersistedSession.mockReset().mockResolvedValue(undefined);
    state.clearPersistedHomeFeed.mockReset().mockResolvedValue(undefined);
    state.readPersistedSession.mockReset().mockResolvedValue(null);
    state.deleteAccount.mockReset();
    state.queryClient.clear.mockReset();
    state.routerReplace.mockReset();
    state.signOut.mockReset().mockResolvedValue({ error: null });
    state.unregisterPush.mockReset().mockResolvedValue(undefined);
    state.startAutoRefresh.mockReset().mockResolvedValue(undefined);
    state.stopAutoRefresh.mockReset().mockResolvedValue(undefined);
    state.duringSignOut.mockReset().mockImplementation((work: () => Promise<unknown>) => work());
  });

  function renderProvider() {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    return { latest, unmount: () => renderer.act(() => tree?.unmount()) };
  }

  async function settle() {
    await renderer.act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });
  }

  it('lifts the startup cover on the stored session while auth-js is still refreshing it', async () => {
    const expired = { ...session, access_token: 'expired-token', expires_at: Math.floor(Date.now() / 1000) - 60 };
    const refreshed = { ...session, access_token: 'refreshed-token' };
    const answers: Array<(result: unknown) => void> = [];
    state.getSession.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    state.readPersistedSession.mockResolvedValue(expired);

    const { latest, unmount } = renderProvider();
    await settle();

    // auth-js has not answered, and the person is already in.
    expect(answers).toHaveLength(1);
    expect(latest.current?.isLoading).toBe(false);
    expect(latest.current?.user?.id).toBe('user-1');

    // The stored access token has expired, so a request waits on auth-js for a
    // fresh one rather than sending it.
    const getAccessToken = (latest.current?.api as unknown as {
      getAccessTokenForTest: () => Promise<string | null>;
    }).getAccessTokenForTest;
    const token = getAccessToken();
    await settle();
    expect(answers).toHaveLength(2);

    await renderer.act(async () => {
      for (const answer of answers) answer({ data: { session: refreshed }, error: null });
    });
    await expect(token).resolves.toBe('refreshed-token');
    await settle();
    expect(latest.current?.session?.access_token).toBe('refreshed-token');
    unmount();
  });

  it('keeps the stored session when refreshing it fails on the network', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    state.readPersistedSession.mockResolvedValue(session);
    const { latest, unmount } = renderProvider();
    await settle();
    expect(latest.current?.user?.id).toBe('user-1');

    // auth-js reports no initial session when its refresh fails on the network,
    // while keeping the session stored.
    await renderer.act(async () => {
      state.authCallback?.('INITIAL_SESSION', null);
    });
    await settle();
    expect(latest.current?.user?.id).toBe('user-1');

    await renderer.act(async () => {
      state.sessionResolve?.({
        data: { session: null },
        error: { __isAuthError: true, name: 'AuthRetryableFetchError', message: 'Network request failed' },
      });
    });
    await settle();
    expect(latest.current?.user?.id).toBe('user-1');
    expect(state.clearPersistedSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Could not refresh the stored session yet; keeping it', expect.anything());
    warn.mockRestore();
    unmount();
  });

  it('signs out on screen once auth-js has deleted the stored session', async () => {
    state.readPersistedSession.mockResolvedValue(session);
    const { latest, unmount } = renderProvider();
    await settle();
    expect(latest.current?.user?.id).toBe('user-1');

    state.readPersistedSession.mockResolvedValue(null);
    await renderer.act(async () => {
      state.authCallback?.('INITIAL_SESSION', null);
    });
    await settle();
    expect(latest.current?.user).toBeNull();
    unmount();
  });

  it('never lets a slow storage read replace the answer auth-js has given', async () => {
    let finishRead: (value: unknown) => void = () => undefined;
    state.readPersistedSession.mockImplementation(() => new Promise((resolve) => {
      finishRead = resolve;
    }));
    const refreshed = { ...session, access_token: 'refreshed-token' };
    const { latest, unmount } = renderProvider();
    await settle();

    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session: refreshed }, error: null });
    });
    await settle();
    expect(latest.current?.session?.access_token).toBe('refreshed-token');

    await renderer.act(async () => {
      finishRead({ ...session, access_token: 'stale-token' });
    });
    await settle();
    expect(latest.current?.session?.access_token).toBe('refreshed-token');
    unmount();
  });

  it('reveals the persisted user before profile I/O and deduplicates the auth event refresh', async () => {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return React.createElement('probe', { loading: latest.current.isLoading });
    }

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    expect(latest.current?.isLoading).toBe(true);

    await renderer.act(async () => {
      await Promise.resolve();
    });
    expect(state.getSession).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session }, error: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest.current?.isLoading).toBe(false);
    expect(latest.current?.user?.id).toBe('user-1');
    expect(latest.current?.credits).toBeNull();
    expect(state.queryClient.fetchQuery).toHaveBeenCalledTimes(1);

    const getAccessToken = (latest.current?.api as unknown as {
      getAccessTokenForTest: () => Promise<string | null>;
    }).getAccessTokenForTest;
    await expect(getAccessToken()).resolves.toBe('access-token');
    await expect(getAccessToken()).resolves.toBe('access-token');
    expect(state.getSession).toHaveBeenCalledTimes(1);

    renderer.act(() => {
      state.authCallback?.('SIGNED_IN', session);
    });
    expect(state.queryClient.fetchQuery).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      state.profileResolve?.({ credits: 37 });
      await Promise.resolve();
    });
    expect(latest.current?.credits).toBe(37);

    renderer.act(() => tree?.unmount());
  });

  it('finishes signing out on this phone when the server cannot confirm it', async () => {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session }, error: null });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // What auth-js returns when the logout request is aborted or offline.
    state.signOut.mockResolvedValueOnce({ error: new Error('Supabase auth request timed out after 10000ms') });
    await renderer.act(async () => {
      await latest.current?.signOut();
    });

    expect(state.stopAutoRefresh.mock.invocationCallOrder[0]).toBeLessThan(state.signOut.mock.invocationCallOrder[0]);
    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(state.duringSignOut).toHaveBeenCalledOnce();
    expect(state.unregisterPush).toHaveBeenCalledWith(expect.anything(), { signal: expect.any(AbortSignal) });
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    // The home feed saved for the next launch was ranked for the person leaving.
    expect(state.clearPersistedHomeFeed).toHaveBeenCalledOnce();
    expect(latest.current?.user).toBeNull();
    expect(state.routerReplace).toHaveBeenCalledWith('/auth');
    expect(warn).toHaveBeenCalledOnce();
    // The refresh timer resumes only once the old session has left storage.
    expect(state.startAutoRefresh).toHaveBeenCalledOnce();
    expect(state.startAutoRefresh.mock.invocationCallOrder[0])
      .toBeGreaterThan(state.clearPersistedSession.mock.invocationCallOrder[0]);
    warn.mockRestore();
    renderer.act(() => tree?.unmount());
  });

  it('keeps the session when sign-out fails on the phone itself', async () => {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session }, error: null });
    });

    state.signOut.mockRejectedValueOnce(new Error('Keychain unavailable'));
    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.signOut().catch((error: unknown) => {
        failure = error;
      });
    });

    expect((failure as Error).message).toBe('Keychain unavailable');
    expect(state.clearPersistedSession).not.toHaveBeenCalled();
    expect(latest.current?.user?.id).toBe('user-1');
    expect(latest.current?.isSigningOut).toBe(false);
    expect(state.routerReplace).not.toHaveBeenCalled();
    expect(state.startAutoRefresh).toHaveBeenCalledOnce();
    renderer.act(() => tree?.unmount());
  });

  it('reports a sign-out while it runs, and a second tap joins the first', async () => {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return null;
    }
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session }, error: null });
    });
    let finishServerSignOut: ((result: { error: null }) => void) | undefined;
    state.signOut.mockImplementationOnce(() => new Promise((resolve) => {
      finishServerSignOut = resolve;
    }));

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await renderer.act(async () => {
      first = latest.current?.signOut();
      second = latest.current?.signOut();
    });

    expect(second).toBe(first);
    expect(latest.current?.isSigningOut).toBe(true);
    expect(state.signOut).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      finishServerSignOut?.({ error: null });
      await first;
    });

    expect(latest.current?.isSigningOut).toBe(false);
    expect(state.routerReplace).toHaveBeenCalledWith('/auth');
    renderer.act(() => tree?.unmount());
  });

  it('keeps local push state on a rejected deletion and clears it only after success', async () => {
    const latest: { current: ReturnType<typeof useAuth> | null } = { current: null };
    function Probe() {
      latest.current = useAuth();
      return React.createElement('probe');
    }

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<AuthProvider><Probe /></AuthProvider>);
    });
    await renderer.act(async () => {
      await Promise.resolve();
    });
    await renderer.act(async () => {
      state.sessionResolve?.({ data: { session }, error: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    state.deleteAccount.mockRejectedValueOnce(new Error('Reauthentication required'));
    await expect(latest.current?.deleteAccount()).rejects.toThrow('Reauthentication required');
    expect(state.clearLocalPush).not.toHaveBeenCalled();
    expect(state.clearPersistedSession).not.toHaveBeenCalled();
    expect(state.queryClient.clear).not.toHaveBeenCalled();

    state.deleteAccount.mockResolvedValueOnce({ success: true, deleted: true });
    await expect(latest.current?.deleteAccount()).resolves.toBeUndefined();
    expect(state.clearLocalPush).toHaveBeenCalledOnce();
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.queryClient.clear).toHaveBeenCalledOnce();

    renderer.act(() => tree?.unmount());
  });
});

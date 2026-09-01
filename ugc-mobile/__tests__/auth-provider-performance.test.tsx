// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  clearLocalPush: vi.fn(),
  clearPersistedSession: vi.fn(),
  deleteAccount: vi.fn(),
  getSession: vi.fn(),
  profileResolve: null as null | ((profile: { credits: number }) => void),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn() },
  sessionResolve: null as null | ((result: unknown) => void),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => state.queryClient,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.0.0' } },
}));

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
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
vi.mock('../lib/generation-model-catalog', () => ({ GENERATION_MODEL_CATALOG_SCHEMA_VERSION: 1 }));
vi.mock('../lib/apple-auth', () => ({ signInWithNativeApple: vi.fn() }));
vi.mock('../lib/google-auth', () => ({ signInWithGoogleOAuth: vi.fn() }));
vi.mock('../lib/referral-attribution', () => ({ claimPendingReferral: vi.fn(async () => undefined) }));
vi.mock('../lib/notifications', () => ({
  clearLocalMobilePushRegistration: state.clearLocalPush,
  registerForMobilePushNotifications: vi.fn(async () => undefined),
  subscribeToMobilePushTokenChanges: vi.fn(() => vi.fn()),
  unregisterMobilePushNotifications: vi.fn(async () => undefined),
}));
vi.mock('../lib/supabase-auth-recovery', () => ({
  isInvalidRefreshTokenError: () => false,
  isNetworkRequestFailedError: () => false,
  supabaseNetworkFailureMessage: () => 'Network unavailable',
}));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: state.clearPersistedSession,
  initializeSupabaseAuth: vi.fn(async () => undefined),
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: state.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        state.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
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
    state.deleteAccount.mockReset();
    state.queryClient.clear.mockReset();
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

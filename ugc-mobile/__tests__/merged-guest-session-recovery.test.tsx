// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  clearGuestMergeTicket: vi.fn(),
  clearPersistedSession: vi.fn(),
  getSession: vi.fn(),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn() },
  replace: vi.fn(),
  sessionResolve: null as null | ((result: unknown) => void),
  signInAnonymously: vi.fn(),
  signOut: vi.fn(),
  unregisterPush: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => state.queryClient,
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { version: '1.0.0' } },
}));

// One stable object, never a fresh literal per render: an unstable router mock
// re-runs the provider's effects forever and hangs the suite.
vi.mock('expo-router', () => ({
  router: { replace: state.replace },
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
  createApiClient: () => ({ getProfile: vi.fn() }),
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
  clearGuestMergeTicket: state.clearGuestMergeTicket,
}));
vi.mock('../lib/generation-model-catalog', () => ({ GENERATION_MODEL_CATALOG_SCHEMA_VERSION: 1 }));
vi.mock('../lib/apple-auth', () => ({ signInWithNativeApple: vi.fn() }));
vi.mock('../lib/google-auth', () => ({ signInWithGoogleOAuth: vi.fn() }));
vi.mock('../lib/referral-attribution', () => ({ claimPendingReferral: vi.fn(async () => undefined) }));
vi.mock('../lib/notifications', () => ({
  clearLocalMobilePushRegistration: vi.fn(async () => undefined),
  registerForMobilePushNotifications: vi.fn(async () => undefined),
  subscribeToMobilePushTokenChanges: vi.fn(() => vi.fn()),
  unregisterMobilePushNotifications: state.unregisterPush,
}));
vi.mock('../lib/supabase-auth-recovery', () => ({
  isInvalidRefreshTokenError: () => false,
  isNetworkRequestFailedError: () => false,
  isRetryableRefreshError: () => false,
  supabaseNetworkFailureMessage: () => 'Network unavailable',
}));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: state.clearPersistedSession,
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
      signInAnonymously: state.signInAnonymously,
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: state.signOut,
    },
  },
}));

import { AuthProvider, useAuth } from '../lib/auth';

function sessionFor(user: Record<string, unknown>) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user,
  };
}

const guestSession = sessionFor({ id: 'guest-1', is_anonymous: true });
const registeredSession = sessionFor({ id: 'user-1', email: 'creator@example.com' });

async function mountWith(session: unknown) {
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

  return { latest, unmount: () => renderer.act(() => tree?.unmount()) };
}

describe('abandoning a guest session the server has merged', () => {
  beforeEach(() => {
    state.authCallback = null;
    state.sessionResolve = null;
    state.getSession.mockReset().mockImplementation(() => new Promise((resolve) => {
      state.sessionResolve = resolve;
    }));
    state.queryClient.fetchQuery.mockReset().mockResolvedValue({ credits: 0 });
    state.queryClient.clear.mockReset();
    state.clearPersistedSession.mockReset().mockResolvedValue(undefined);
    state.clearGuestMergeTicket.mockReset().mockResolvedValue(undefined);
    state.replace.mockReset();
    state.signOut.mockReset().mockResolvedValue({ error: null });
    state.signInAnonymously.mockReset().mockResolvedValue({
      data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }) },
      error: null,
    });
    state.unregisterPush.mockReset().mockResolvedValue(undefined);
  });

  it('signs the spent guest out locally and sends it to sign-in with the reason', async () => {
    const { latest, unmount } = await mountWith(guestSession);

    await renderer.act(async () => {
      await latest.current?.abandonMergedGuestSession();
    });

    // Local scope only. A global sign-out reaches for sessions that now belong
    // to the registered account this guest was folded into.
    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.replace).toHaveBeenCalledWith('/auth?notice=session-merged');

    unmount();
  });

  it('leaves the merge ticket alone, because it is the only copy of the credit secret', async () => {
    const { latest, unmount } = await mountWith(guestSession);

    await renderer.act(async () => {
      await latest.current?.abandonMergedGuestSession();
    });

    expect(state.clearGuestMergeTicket).not.toHaveBeenCalled();

    unmount();
  });

  it('does not call the push unregister route, which would itself be refused', async () => {
    const { latest, unmount } = await mountWith(guestSession);

    await renderer.act(async () => {
      await latest.current?.abandonMergedGuestSession();
    });

    expect(state.unregisterPush).not.toHaveBeenCalled();

    unmount();
  });

  it('drops back to a fresh guest so public browsing still works', async () => {
    const { latest, unmount } = await mountWith(guestSession);

    // The bootstrap re-reads the session before minting anything. Past mount,
    // answer it the way the real client does once the local sign-out has
    // landed: no session at all.
    state.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await renderer.act(async () => {
      await latest.current?.abandonMergedGuestSession();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.signInAnonymously).toHaveBeenCalled();

    unmount();
  });

  it('never tears down a registered session', async () => {
    // SESSION_MERGED is only ever issued for an anonymous identity. If one
    // reaches a registered session it is an upstream bug, and signing that
    // person out would be a far worse outcome than ignoring it.
    const { latest, unmount } = await mountWith(registeredSession);

    await renderer.act(async () => {
      await latest.current?.abandonMergedGuestSession();
    });

    expect(state.signOut).not.toHaveBeenCalled();
    expect(state.clearPersistedSession).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();

    unmount();
  });
});

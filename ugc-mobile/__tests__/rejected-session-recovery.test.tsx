// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AuthApiError } from '@supabase/supabase-js';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  clearLocalPush: vi.fn(),
  clearPersistedSession: vi.fn(),
  getSession: vi.fn(),
  probe: vi.fn(),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn() },
  refreshSession: vi.fn(),
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
  env: {
    apiBaseUrl: 'https://api.example.com',
    supabaseUrl: 'https://project.supabase.example',
    supabasePublishableKey: 'publishable-key',
  },
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
  unregisterMobilePushNotifications: state.unregisterPush,
}));
vi.mock('../lib/supabase-session-probe', () => ({ probeSupabaseSession: state.probe }));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: state.clearPersistedSession,
  duringSignOut: (work: () => Promise<unknown>) => work(),
  initializeSupabaseAuth: vi.fn(async () => undefined),
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: state.getSession,
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        state.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      refreshSession: state.refreshSession,
      signInAnonymously: state.signInAnonymously,
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: state.signOut,
      startAutoRefresh: vi.fn(async () => undefined),
      stopAutoRefresh: vi.fn(async () => undefined),
    },
  },
}));

import { AuthProvider, useAuth } from '../lib/auth';

function sessionFor(user: Record<string, unknown>, accessToken = 'access-token') {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user,
  };
}

const guestSession = sessionFor({ id: 'guest-1', is_anonymous: true }, 'guest-token');
const registeredSession = sessionFor({ id: 'user-1', email: 'creator@example.com' }, 'refused-token');

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

  // Past mount, answer the way the real client does once a local sign-out has
  // landed, so the guest bootstrap proceeds to mint a fresh guest.
  state.getSession.mockResolvedValue({ data: { session: null }, error: null });

  return { latest, unmount: () => renderer.act(() => tree?.unmount()) };
}

async function recover(latest: { current: ReturnType<typeof useAuth> | null }) {
  await renderer.act(async () => {
    await latest.current?.recoverRejectedSession();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectNothingTornDown() {
  expect(state.signOut).not.toHaveBeenCalled();
  expect(state.clearPersistedSession).not.toHaveBeenCalled();
  expect(state.clearLocalPush).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.signInAnonymously).not.toHaveBeenCalled();
}

describe('recovering from a session ended elsewhere', () => {
  beforeEach(() => {
    state.authCallback = null;
    state.sessionResolve = null;
    state.getSession.mockReset().mockImplementation(() => new Promise((resolve) => {
      state.sessionResolve = resolve;
    }));
    state.queryClient.fetchQuery.mockReset().mockResolvedValue({ credits: 0 });
    state.queryClient.clear.mockReset();
    state.clearPersistedSession.mockReset().mockResolvedValue(undefined);
    state.clearLocalPush.mockReset().mockResolvedValue(undefined);
    state.probe.mockReset();
    state.refreshSession.mockReset();
    state.replace.mockReset();
    // auth-js clears the local session on a local sign-out and says so.
    state.signOut.mockReset().mockImplementation(async () => {
      state.authCallback?.('SIGNED_OUT', null);
      return { error: null };
    });
    state.signInAnonymously.mockReset().mockResolvedValue({
      data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }) },
      error: null,
    });
    state.unregisterPush.mockReset().mockResolvedValue(undefined);
  });

  it('asks Supabase about the exact token that was refused', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('alive');

    await recover(latest);

    expect(state.probe).toHaveBeenCalledWith({
      supabaseUrl: 'https://project.supabase.example',
      publishableKey: 'publishable-key',
      accessToken: 'refused-token',
    });

    unmount();
  });

  it('checks once however many refusals arrive together', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    let answer: (verdict: string) => void = () => undefined;
    state.probe.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));

    await renderer.act(async () => {
      const recoveries = [
        latest.current?.recoverRejectedSession(),
        latest.current?.recoverRejectedSession(),
        latest.current?.recoverRejectedSession(),
      ];
      await Promise.resolve();
      answer('alive');
      await Promise.all(recoveries);
    });

    expect(state.probe).toHaveBeenCalledOnce();

    unmount();
  });

  it('keeps a session Supabase still accepts', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('alive');

    await recover(latest);

    expectNothingTornDown();
    expect(state.refreshSession).not.toHaveBeenCalled();
    expect(latest.current?.user?.id).toBe('user-1');

    unmount();
  });

  it('changes nothing while Supabase is not answering cleanly, so an auth outage cannot sign anyone out', async () => {
    // The API answers 401 whenever it cannot verify a token, including while
    // Supabase Auth is failing. A refresh forced then would be deleted by
    // auth-js on a 500 or a rate limit, signing out every device that asked.
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('unknown');

    await recover(latest);

    expect(state.refreshSession).not.toHaveBeenCalled();
    expectNothingTornDown();
    expect(latest.current?.user?.id).toBe('user-1');

    unmount();
  });

  it('signs a registered device out locally and tells the person why', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('ended');

    await recover(latest);

    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.clearLocalPush).toHaveBeenCalledOnce();
    expect(state.replace).toHaveBeenCalledWith('/auth?notice=signed-out');
    expect(latest.current?.user).toBeNull();
    // Public browsing keeps working on a fresh guest while they decide.
    expect(state.signInAnonymously).toHaveBeenCalled();
    // Supabase already said the session is gone; there is nothing to refresh.
    expect(state.refreshSession).not.toHaveBeenCalled();

    unmount();
  });

  it('does not call the push unregister route, which would be refused like the rest', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('ended');

    await recover(latest);

    expect(state.unregisterPush).not.toHaveBeenCalled();

    unmount();
  });

  it('moves a guest onto a fresh guest without interrupting what it was doing', async () => {
    const { latest, unmount } = await mountWith(guestSession);
    state.probe.mockResolvedValue('ended');

    await recover(latest);

    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.signInAnonymously).toHaveBeenCalled();
    // A guest has nothing to sign back in to, and no push registration.
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.clearLocalPush).not.toHaveBeenCalled();

    unmount();
  });

  it('settles a token refused for another reason with one refresh, keeping a live session', async () => {
    // An expired or unverifiable token: Supabase answered cleanly, so a forced
    // refresh is safe and simply issues a new token.
    const { latest, unmount } = await mountWith(registeredSession);
    const refreshed = sessionFor(registeredSession.user, 'fresh-access-token');
    state.probe.mockResolvedValue('refused');
    state.refreshSession.mockImplementation(async () => {
      state.authCallback?.('TOKEN_REFRESHED', refreshed);
      return { data: { user: refreshed.user, session: refreshed }, error: null };
    });

    await recover(latest);

    expect(state.refreshSession).toHaveBeenCalledOnce();
    expectNothingTornDown();
    expect(latest.current?.session?.access_token).toBe('fresh-access-token');

    unmount();
  });

  it('signs out when that refresh is refused as well', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    state.probe.mockResolvedValue('refused');
    // What auth-js 2.105 does when Supabase refuses the refresh token of a
    // session that no longer exists: delete it locally, emit SIGNED_OUT, and
    // return the refusal.
    state.refreshSession.mockImplementation(async () => {
      state.authCallback?.('SIGNED_OUT', null);
      return {
        data: { user: null, session: null },
        error: new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found'),
      };
    });

    await recover(latest);

    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.replace).toHaveBeenCalledWith('/auth?notice=signed-out');

    unmount();
  });

  it('leaves alone an identity that replaced the refused one while the check was running', async () => {
    const { latest, unmount } = await mountWith(registeredSession);
    const replacement = sessionFor({ id: 'user-2', email: 'someone@example.com' }, 'replacement-token');
    state.probe.mockImplementation(async () => {
      state.authCallback?.('SIGNED_IN', replacement);
      return 'ended';
    });

    await recover(latest);

    expectNothingTornDown();
    expect(latest.current?.user?.id).toBe('user-2');

    unmount();
  });

  it('does nothing without a session to check', async () => {
    const { latest, unmount } = await mountWith(null);

    await recover(latest);

    expect(state.probe).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();

    unmount();
  });
});

describe('signing out', () => {
  beforeEach(() => {
    state.authCallback = null;
    state.sessionResolve = null;
    state.getSession.mockReset().mockImplementation(() => new Promise((resolve) => {
      state.sessionResolve = resolve;
    }));
    state.queryClient.fetchQuery.mockReset().mockResolvedValue({ credits: 0 });
    state.clearPersistedSession.mockReset().mockResolvedValue(undefined);
    state.replace.mockReset();
    state.signOut.mockReset().mockResolvedValue({ error: null });
    state.signInAnonymously.mockReset().mockResolvedValue({
      data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }) },
      error: null,
    });
    state.unregisterPush.mockReset().mockResolvedValue(undefined);
  });

  it('ends only the session on this device', async () => {
    // Supabase's default scope is global: signing out on one phone used to end
    // the account's session on every other device too, which then refused every
    // request until its token ran out.
    const { latest, unmount } = await mountWith(registeredSession);

    await renderer.act(async () => {
      await latest.current?.signOut();
    });

    expect(state.signOut).toHaveBeenCalledOnce();
    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });

    unmount();
  });
});

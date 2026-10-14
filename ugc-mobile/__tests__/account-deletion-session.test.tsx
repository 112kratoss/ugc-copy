// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  clearGuestMergeTicket: vi.fn(),
  clearHomeFeed: vi.fn(),
  clearLocalPush: vi.fn(),
  clearPersistedSession: vi.fn(),
  clearSearchHistory: vi.fn(),
  deleteAccount: vi.fn(),
  dismissTo: vi.fn(),
  feedTransition: { cancel: vi.fn(), commit: vi.fn() },
  getSession: vi.fn(),
  probe: vi.fn(),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn(), removeQueries: vi.fn() },
  refreshSession: vi.fn(),
  replace: vi.fn(),
  sessionResolve: null as null | ((result: unknown) => void),
  signInAnonymously: vi.fn(),
  signOut: vi.fn(),
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
  router: { replace: state.replace, dismissTo: state.dismissTo },
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

// The real error classes and readers: what a deletion's answer means is
// decided on them. Only the client that sends the request is a stand-in.
vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  createApiClient: () => ({ deleteAccount: state.deleteAccount, getProfile: vi.fn() }),
}));

vi.mock('../lib/feed-installation-id', () => ({ getFeedInstallationId: vi.fn() }));
vi.mock('../lib/feed-event-queue', () => ({
  beginShowcaseFeedEventIdentityTransition: () => state.feedTransition,
  configureFeedEventQueue: vi.fn(),
  flushShowcaseFeedEvents: vi.fn(async () => undefined),
  restoreShowcaseFeedEvents: vi.fn(async () => undefined),
}));
vi.mock('../lib/guest-merge-ticket-storage', () => ({
  readGuestMergeTicket: vi.fn(async () => null),
  storeGuestMergeTicket: vi.fn(async () => undefined),
  clearGuestMergeTicket: state.clearGuestMergeTicket,
}));
vi.mock('../lib/persisted-account-state', () => ({
  clearPersistedAccountState: vi.fn(async () => undefined),
  persistAccountStateOnChange: vi.fn(() => () => undefined),
  restorePersistedAccountState: vi.fn(async () => null),
}));
vi.mock('../lib/persisted-home-feed', () => ({ clearPersistedHomeFeed: state.clearHomeFeed }));
vi.mock('../lib/search-history', () => ({ clearSearchHistory: state.clearSearchHistory }));
vi.mock('../lib/apple-auth', () => ({
  authorizeNativeAppleAccountDeletion: vi.fn(),
  signInWithNativeApple: vi.fn(),
}));
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
  isRetryableRefreshError: () => false,
  isSessionEndedRefreshError: () => true,
  supabaseNetworkFailureMessage: () => 'Network unavailable',
}));
vi.mock('../lib/supabase-session-probe', () => ({ probeSupabaseSession: state.probe }));
vi.mock('../lib/supabase', () => ({
  clearPersistedSupabaseAuthSession: state.clearPersistedSession,
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
      refreshSession: state.refreshSession,
      signInAnonymously: state.signInAnonymously,
      signInWithPassword: vi.fn(),
      signOut: state.signOut,
      startAutoRefresh: vi.fn(async () => undefined),
      stopAutoRefresh: vi.fn(async () => undefined),
    },
  },
}));

import { ApiError } from '../lib/api-client';
import {
  AuthProvider,
  isAccountDeletionUnderway,
  isAccountReauthenticationRequired,
  useAuth,
} from '../lib/auth';

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

const registeredSession = sessionFor({ id: 'user-1', email: 'creator@example.com' }, 'deleting-token');
const guestSession = sessionFor({ id: 'guest-1', is_anonymous: true }, 'guest-token');

async function flush() {
  await renderer.act(async () => {
    for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
  });
}

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
  await flush();
  await renderer.act(async () => {
    state.sessionResolve?.({ data: { session }, error: null });
  });
  await flush();
  // Past mount, auth-js answers the way it does once the stored session has
  // been cleared: no session, so the guest bootstrap mints one.
  state.getSession.mockResolvedValue({ data: { session: null }, error: null });

  return { latest, unmount: () => renderer.act(() => tree?.unmount()) };
}

function expectSessionEndedOnce() {
  expect(state.clearPersistedSession).toHaveBeenCalledOnce();
  expect(state.clearLocalPush).toHaveBeenCalledOnce();
  expect(state.clearHomeFeed).toHaveBeenCalledOnce();
  expect(state.clearSearchHistory).toHaveBeenCalledOnce();
  expect(state.queryClient.clear).toHaveBeenCalledOnce();
  // A fresh guest, so browsing and buying keep working (audit 04-8).
  expect(state.signInAnonymously).toHaveBeenCalledOnce();
  // One move, to Home: no stop at sign-in on the way (audit 04-8).
  expect(state.dismissTo).toHaveBeenCalledOnce();
  expect(state.dismissTo).toHaveBeenCalledWith('/');
  expect(state.replace).not.toHaveBeenCalled();
}

function expectSessionKept() {
  expect(state.clearPersistedSession).not.toHaveBeenCalled();
  expect(state.clearLocalPush).not.toHaveBeenCalled();
  expect(state.queryClient.clear).not.toHaveBeenCalled();
  expect(state.signInAnonymously).not.toHaveBeenCalled();
  expect(state.dismissTo).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
}

beforeEach(() => {
  state.authCallback = null;
  state.sessionResolve = null;
  state.getSession.mockReset().mockImplementation(() => new Promise((resolve) => {
    state.sessionResolve = resolve;
  }));
  state.queryClient.fetchQuery.mockReset().mockResolvedValue({ credits: 0 });
  state.queryClient.clear.mockReset();
  state.queryClient.removeQueries.mockReset();
  for (const clear of [state.clearPersistedSession, state.clearLocalPush, state.clearHomeFeed, state.clearSearchHistory, state.clearGuestMergeTicket]) {
    clear.mockReset().mockResolvedValue(undefined);
  }
  state.deleteAccount.mockReset();
  state.dismissTo.mockReset();
  state.replace.mockReset();
  state.feedTransition.cancel.mockReset();
  state.feedTransition.commit.mockReset();
  state.probe.mockReset();
  state.refreshSession.mockReset().mockResolvedValue({ error: null });
  state.signOut.mockReset().mockResolvedValue({ error: null });
  state.signInAnonymously.mockReset().mockResolvedValue({
    data: { session: sessionFor({ id: 'guest-2', is_anonymous: true }, 'fresh-guest-token') },
    error: null,
  });
});

// The answers of DELETE /api/account (work/reports/wp4.md), as the client
// throws them.
const notStarted = new ApiError('Account deletion could not be completed. Please try again.', 500, {
  error: 'Account deletion could not be completed. Please try again.',
  code: 'ACCOUNT_DELETION_NOT_STARTED',
  deletionScheduled: false,
}, undefined, 'ACCOUNT_DELETION_NOT_STARTED');
const retryScheduled = new ApiError('Your account is being deleted and will be removed automatically.', 500, {
  error: 'Your account is being deleted and will be removed automatically.',
  code: 'ACCOUNT_DELETION_RETRY_SCHEDULED',
  deletionScheduled: true,
}, undefined, 'ACCOUNT_DELETION_RETRY_SCHEDULED');
const platformFailure = new ApiError('Request failed with status 500', 500, 'A server error has occurred');
const accountDeleting = new ApiError('This account is being permanently deleted.', 409, {
  error: 'This account is being permanently deleted.',
  code: 'ACCOUNT_DELETING',
}, undefined, 'ACCOUNT_DELETING');
const timedOut = new ApiError('Network request failed. Please check your connection and try again.', 0, {
  url: 'https://api.example.com/api/account',
  cause: 'Request timed out after 120000ms',
  timedOut: true,
});
const offline = new ApiError('Network request failed. Please check your connection and try again.', 0, {
  url: 'https://api.example.com/api/account',
  cause: 'Network request failed',
});
const recentSignInRequired = new ApiError('Please sign in again before permanently deleting your account.', 403, {
  error: 'Please sign in again before permanently deleting your account.',
  code: 'RECENT_AUTH_REQUIRED',
  reason: 'reauthentication_required',
  reauthenticate: true,
}, undefined, 'RECENT_AUTH_REQUIRED');
const identityUnavailable = new ApiError('Identity verification is temporarily unavailable. Please try again.', 503, {
  error: 'Identity verification is temporarily unavailable. Please try again.',
  code: 'IDENTITY_CHECK_UNAVAILABLE',
}, undefined, 'IDENTITY_CHECK_UNAVAILABLE');
const rateLimited = new ApiError('Too many requests.', 429, { error: 'Too many requests.' });

describe('what a deletion answer means for the account', () => {
  it.each([
    ['a 409 ACCOUNT_DELETING', accountDeleting],
    ['a 500 that says the deletion is scheduled', retryScheduled],
    ['a platform 500 with no JSON', platformFailure],
    ['a request this app stopped waiting for', timedOut],
  ])('treats %s as a deletion under way', (_name, error) => {
    expect(isAccountDeletionUnderway(error)).toBe(true);
  });

  it.each([
    ['a 500 that says nothing was started', notStarted],
    ['a refusal until the person signs in again', recentSignInRequired],
    ['an identity check that was unavailable', identityUnavailable],
    ['a rate limit', rateLimited],
    ['a request that never got out', offline],
    ['an error that is not an API answer', new Error('Keychain unavailable')],
  ])('treats %s as not deleted', (_name, error) => {
    expect(isAccountDeletionUnderway(error)).toBe(false);
  });

  it('opens the sign-in-again card on the reason the server gives, and on the legacy codes', () => {
    const appleFailed = new ApiError('Apple could not verify this deletion request.', 403, {
      code: 'APPLE_REAUTH_FAILED',
      reason: 'reauthentication_required',
      reauthenticate: true,
    }, undefined, 'APPLE_REAUTH_FAILED');
    const legacyApple = new ApiError('Continue with Apple.', 403, { code: 'APPLE_REAUTH_REQUIRED' }, undefined, 'APPLE_REAUTH_REQUIRED');
    const mismatch = new ApiError('Signed in to a different account.', 403, { code: 'ACCOUNT_REAUTH_MISMATCH' }, undefined, 'ACCOUNT_REAUTH_MISMATCH');

    expect(isAccountReauthenticationRequired(recentSignInRequired)).toBe(true);
    expect(isAccountReauthenticationRequired(appleFailed)).toBe(true);
    expect(isAccountReauthenticationRequired(legacyApple)).toBe(true);
    expect(isAccountReauthenticationRequired(mismatch)).toBe(false);
    expect(isAccountReauthenticationRequired(Object.assign(new Error('Sign in again.'), { code: 'RECENT_AUTH_REQUIRED' }))).toBe(false);
  });
});

describe('deleting the account from this phone', () => {
  it('signs out, starts a fresh guest and moves to Home once the server has scheduled the deletion (202)', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(registeredSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('scheduled');
    expectSessionEndedOnce();
    expect(state.feedTransition.commit).toHaveBeenCalledOnce();
    expect(state.feedTransition.cancel).not.toHaveBeenCalled();
    expect(latest.current?.user).toBeNull();
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });

  it('says deleted for a deletion the server had already finished (200)', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: true, cleanupPending: false, alreadyDeleted: true });
    const { latest, unmount } = await mountWith(registeredSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('deleted');
    expectSessionEndedOnce();
    unmount();
  });

  it.each([
    ['409 ACCOUNT_DELETING', accountDeleting],
    ['a 500 that says the deletion is scheduled', retryScheduled],
    ['a platform 500', platformFailure],
    ['no answer within the deadline', timedOut],
  ])('ends the session the same way after %s, which never meant "not deleted"', async (_name, error) => {
    state.deleteAccount.mockRejectedValue(error);
    const { latest, unmount } = await mountWith(registeredSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('scheduled');
    expectSessionEndedOnce();
    unmount();
  });

  it.each([
    ['a 500 that says nothing was started', notStarted],
    ['a refusal until the person signs in again', recentSignInRequired],
    ['an identity check that was unavailable', identityUnavailable],
    ['a request that never got out', offline],
  ])('keeps the account and the session after %s', async (_name, error) => {
    state.deleteAccount.mockRejectedValue(error);
    const { latest, unmount } = await mountWith(registeredSession);

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.deleteAccount().catch((thrown: unknown) => {
        failure = thrown;
      });
    });
    await flush();

    expect(failure).toBe(error);
    expectSessionKept();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    expect(latest.current?.user?.id).toBe('user-1');
    unmount();
  });
});

describe('an account being deleted while this phone is signed in to it (409 ACCOUNT_DELETING)', () => {
  it('ends a registered session, starts a fresh guest and moves to Home', async () => {
    const { latest, unmount } = await mountWith(registeredSession);

    let ended: unknown;
    await renderer.act(async () => {
      ended = await latest.current?.leaveDeletingAccount();
    });
    await flush();

    expect(ended).toBe(true);
    expectSessionEndedOnce();
    // Nothing is asked of the server: every call would be refused like the
    // request that brought this.
    expect(state.signOut).not.toHaveBeenCalled();
    expect(latest.current?.user).toBeNull();
    unmount();
  });

  it('ends it once however many refusals arrive', async () => {
    const { latest, unmount } = await mountWith(registeredSession);

    let answers: unknown[] = [];
    await renderer.act(async () => {
      answers = await Promise.all([latest.current?.leaveDeletingAccount(), latest.current?.leaveDeletingAccount()]);
    });
    await flush();

    expect(answers).toEqual([true, false]);
    expectSessionEndedOnce();
    unmount();
  });

  it('leaves a guest alone: only a registered account is ever deleted', async () => {
    const { latest, unmount } = await mountWith(guestSession);

    let ended: unknown;
    await renderer.act(async () => {
      ended = await latest.current?.leaveDeletingAccount();
    });

    expect(ended).toBe(false);
    expectSessionKept();
    unmount();
  });

  it('leaves the end to a deletion asked for on this phone, which says it in its own words', async () => {
    let answer: (value: unknown) => void = () => undefined;
    state.deleteAccount.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const { latest, unmount } = await mountWith(registeredSession);

    let deletion: Promise<unknown> | undefined;
    let ended: unknown;
    await renderer.act(async () => {
      deletion = latest.current?.deleteAccount();
      ended = await latest.current?.leaveDeletingAccount();
    });
    expect(ended).toBe(false);
    expectSessionKept();

    await renderer.act(async () => {
      answer({ success: true, deleted: false, deletionScheduled: true });
      await deletion;
    });
    await flush();
    expectSessionEndedOnce();
    unmount();
  });
});

describe("refusals of a deleted account's old token", () => {
  // The server revokes every session before it answers, so a request in flight
  // beside the deletion is refused (401) and starts a check of its own. Until
  // the fresh guest arrives, nothing else on the device says the refused
  // account is gone.
  it('never signs out, or moves, a second time, even before the fresh guest has arrived', async () => {
    let probeAnswer: (verdict: string) => void = () => undefined;
    state.probe.mockImplementation(() => new Promise((resolve) => {
      probeAnswer = resolve;
    }));
    state.signInAnonymously.mockImplementation(() => new Promise(() => undefined));
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(registeredSession);

    let check: Promise<void> | undefined;
    await renderer.act(async () => {
      check = latest.current?.recoverRejectedSession();
    });
    expect(state.probe).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'deleting-token' }));
    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();
    await renderer.act(async () => {
      probeAnswer('ended');
      await check;
    });
    await flush();

    expectSessionEndedOnce();
    expect(state.signOut).not.toHaveBeenCalled();
    unmount();
  });

  it('waits for a deletion still on its way, which ends the session itself', async () => {
    let answer: (value: unknown) => void = () => undefined;
    state.deleteAccount.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    state.probe.mockResolvedValue('ended');
    const { latest, unmount } = await mountWith(registeredSession);

    let deletion: Promise<unknown> | undefined;
    await renderer.act(async () => {
      deletion = latest.current?.deleteAccount();
      await latest.current?.recoverRejectedSession();
    });
    expectSessionKept();
    expect(state.signOut).not.toHaveBeenCalled();

    await renderer.act(async () => {
      answer({ success: true, deleted: false, deletionScheduled: true });
      await deletion;
    });
    await flush();
    expectSessionEndedOnce();
    unmount();
  });
});

describe('wiring', () => {
  const layout = readFileSync(join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

  it('ends the session for a 409 ACCOUNT_DELETING from any screen, inside the auth provider', () => {
    const coordinatorAt = layout.indexOf('<AccountDeletingCoordinator />');

    expect(coordinatorAt).toBeGreaterThan(layout.indexOf('<AuthProvider>'));
    expect(coordinatorAt).toBeLessThan(layout.indexOf('</AuthProvider>'));
  });

  it('registers the handler once, says why only when it ended the session, and unregisters on unmount', () => {
    const start = layout.indexOf('function AccountDeletingCoordinator()');
    const coordinator = layout.slice(start, layout.indexOf('\n}\n', start));

    expect(start).toBeGreaterThan(-1);
    expect(coordinator).toContain('setAccountDeletingHandler(() => {');
    expect(coordinator).toContain('void leaveRef.current()');
    expect(coordinator).toContain('if (ended) showMessageDialog(ACCOUNT_DELETION_SCHEDULED_NOTICE);');
    expect(coordinator).toContain('return () => setAccountDeletingHandler(null);');
  });
});

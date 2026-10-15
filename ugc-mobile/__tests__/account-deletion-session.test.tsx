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
  clearComposerDrafts: vi.fn(),
  clearCreationDrafts: vi.fn(),
  clearGenerationAttempt: vi.fn(),
  clearGuestMergeOutcome: vi.fn(),
  forgetGuestMergeTickets: vi.fn(),
  readGuestMergeTickets: vi.fn(),
  removeGuestMergeTicket: vi.fn(),
  clearHomeFeed: vi.fn(),
  clearLocalPush: vi.fn(),
  clearPersistedSession: vi.fn(),
  clearSearchHistory: vi.fn(),
  deleteAccount: vi.fn(),
  dismissTo: vi.fn(),
  feedTransition: { cancel: vi.fn(), commit: vi.fn() },
  getSession: vi.fn(),
  prepareGuestAccountMerge: vi.fn(),
  probe: vi.fn(),
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn(), getQueryCache: () => ({ subscribe: () => () => undefined }), removeQueries: vi.fn() },
  refreshSession: vi.fn(),
  replace: vi.fn(),
  sessionResolve: null as null | ((result: unknown) => void),
  signInAnonymously: vi.fn(),
  signInWithPassword: vi.fn(),
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
  usePathname: () => '/settings',
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
  createApiClient: () => ({
    deleteAccount: state.deleteAccount,
    getProfile: vi.fn(),
    prepareGuestAccountMerge: state.prepareGuestAccountMerge,
  }),
}));

vi.mock('../lib/feed-installation-id', () => ({ getFeedInstallationId: vi.fn() }));
vi.mock('../lib/feed-event-queue', () => ({
  beginShowcaseFeedEventIdentityTransition: () => state.feedTransition,
  configureFeedEventQueue: vi.fn(),
  flushShowcaseFeedEvents: vi.fn(async () => undefined),
  restoreShowcaseFeedEvents: vi.fn(async () => undefined),
}));
vi.mock('../lib/guest-merge-ticket-storage', () => ({
  bindGuestMergeTicket: vi.fn(async () => undefined),
  clearGuestMergeOutcome: state.clearGuestMergeOutcome,
  forgetGuestMergeTicketsFor: state.forgetGuestMergeTickets,
  readGuestMergeOutcome: vi.fn(async () => null),
  readGuestMergeTickets: state.readGuestMergeTickets,
  removeGuestMergeTicket: state.removeGuestMergeTicket,
  storeGuestMergeOutcome: vi.fn(async () => undefined),
  storeGuestMergeTicket: vi.fn(async () => undefined),
}));
vi.mock('../lib/persisted-account-state', () => ({
  clearPersistedAccountState: vi.fn(async () => undefined),
  persistAccountStateOnChange: vi.fn(() => () => undefined),
  restorePersistedAccountState: vi.fn(async () => null),
}));
vi.mock('../lib/persisted-home-feed', () => ({ clearPersistedHomeFeed: state.clearHomeFeed }));
vi.mock('../lib/creation-draft-resume', () => ({ clearCreationDraftsForUser: state.clearCreationDrafts }));
vi.mock('../lib/post-composer-draft-resume', () => ({ clearComposerDraftsForUser: state.clearComposerDrafts }));
vi.mock('../lib/generation-attempts', () => ({ clearGenerationAttemptForUser: state.clearGenerationAttempt }));
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
  normalizeSupabaseAuthError: (error: unknown) => error,
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
      signInWithPassword: state.signInWithPassword,
      signOut: state.signOut,
      startAutoRefresh: vi.fn(async () => undefined),
      stopAutoRefresh: vi.fn(async () => undefined),
    },
  },
}));

import {
  AccountReauthenticationAccountMismatchError,
  AccountReauthenticationFailedError,
} from '../lib/account-reauthentication';
import { ApiError } from '../lib/api-client';
import {
  AuthProvider,
  isAccountDeletionUnderway,
  isAccountReauthenticationRequired,
  isAmbiguousAccountDeletionAnswer,
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
  for (const clear of [
    state.clearPersistedSession,
    state.clearLocalPush,
    state.clearHomeFeed,
    state.clearSearchHistory,
    state.forgetGuestMergeTickets,
    state.clearGuestMergeOutcome,
    state.removeGuestMergeTicket,
    state.clearCreationDrafts,
    state.clearComposerDrafts,
    state.clearGenerationAttempt,
  ]) {
    clear.mockReset().mockResolvedValue(undefined);
  }
  state.readGuestMergeTickets.mockReset().mockResolvedValue([]);
  state.prepareGuestAccountMerge.mockReset().mockResolvedValue({ ticket: 'a'.repeat(64) });
  state.signInWithPassword.mockReset();
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
const sessionRefused = new ApiError('Unauthorized', 401, {
  error: 'Unauthorized',
  code: 'UNAUTHORIZED',
}, undefined, 'UNAUTHORIZED');
const gatewayTimeout = new ApiError('Request failed with status 504', 504, '<html>Gateway Timeout</html>');
// Given up on while it waited for its session token (api-client, WP2): it
// never left the phone.
const neverSent = new ApiError('Network request failed. Please check your connection and try again.', 0, {
  url: 'https://api.example.com/api/account',
  cause: 'Request timed out after 120000ms before it was sent',
  timedOut: true,
  sent: false,
});
// The proxy's answer to a guest's DELETE before guests could delete their data (C1).
const registrationRequired = new ApiError('Create an account to use this feature.', 403, {
  error: 'Create an account to use this feature.',
  code: 'REGISTRATION_REQUIRED',
}, undefined, 'REGISTRATION_REQUIRED');

describe('what a deletion answer means for the account', () => {
  it.each([
    ['a 409 ACCOUNT_DELETING', accountDeleting],
    ['a 500 that says the deletion is scheduled', retryScheduled],
    ['a request this app stopped waiting for', timedOut],
  ])('treats %s as a deletion under way', (_name, error) => {
    expect(isAccountDeletionUnderway(error)).toBe(true);
    expect(isAmbiguousAccountDeletionAnswer(error)).toBe(false);
  });

  // Audit 04-3: each can follow a deletion that started, or one that never
  // reached the server, so Supabase is asked about the session instead.
  it.each([
    ['a platform 500 with no JSON', platformFailure],
    ['a gateway timeout with no JSON', gatewayTimeout],
    ['a connection lost on the way', offline],
    ['a refused session (401)', sessionRefused],
  ])('cannot tell from %s alone', (_name, error) => {
    expect(isAccountDeletionUnderway(error)).toBe(false);
    expect(isAmbiguousAccountDeletionAnswer(error)).toBe(true);
  });

  it.each([
    ['a 500 that says nothing was started', notStarted],
    ['a refusal until the person signs in again', recentSignInRequired],
    ['an identity check that was unavailable', identityUnavailable],
    ['a rate limit', rateLimited],
    ['a request given up before it left the phone', neverSent],
    ['an error that is not an API answer', new Error('Keychain unavailable')],
  ])('treats %s as not deleted', (_name, error) => {
    expect(isAccountDeletionUnderway(error)).toBe(false);
    expect(isAmbiguousAccountDeletionAnswer(error)).toBe(false);
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
    // The guest tickets the account could still redeem go with it, so the next
    // account on this phone cannot take those credits (audit 04-8), and so
    // does what its links came to.
    expect(state.forgetGuestMergeTickets).toHaveBeenCalledWith('user-1');
    expect(state.clearGuestMergeOutcome).toHaveBeenCalledOnce();
    expect(state.removeGuestMergeTicket).not.toHaveBeenCalled();
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
    expect(state.probe).not.toHaveBeenCalled();
    unmount();
  });

  it.each([
    ['a 500 that says nothing was started', notStarted],
    ['a refusal until the person signs in again', recentSignInRequired],
    ['an identity check that was unavailable', identityUnavailable],
    ['a request given up before it left the phone', neverSent],
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
    expect(state.probe).not.toHaveBeenCalled();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    expect(latest.current?.user?.id).toBe('user-1');
    unmount();
  });
});

// Audit 04-3: a lost answer is told from a refusal by asking Supabase about the
// session the request carried. The deletion revokes every session as it
// starts, so a session that is gone means it started.
describe('an answer that cannot say whether the deletion started', () => {
  it.each([
    ['a lost connection', offline],
    ['a refused session', sessionRefused],
    ['a platform 500 with no JSON', platformFailure],
  ])('asks Supabase about the token the request carried after %s', async (_name, error) => {
    state.deleteAccount.mockRejectedValue(error);
    state.probe.mockResolvedValue('alive');
    const { latest, unmount } = await mountWith(registeredSession);

    await renderer.act(async () => {
      await latest.current?.deleteAccount().catch(() => undefined);
    });

    expect(state.probe).toHaveBeenCalledOnce();
    expect(state.probe).toHaveBeenCalledWith({
      supabaseUrl: 'https://project.supabase.example',
      publishableKey: 'publishable-key',
      accessToken: 'deleting-token',
    });
    unmount();
  });

  it('reads a lost connection as a deletion under way when the session is gone', async () => {
    state.deleteAccount.mockRejectedValue(offline);
    state.probe.mockResolvedValue('ended');
    const { latest, unmount } = await mountWith(registeredSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('scheduled');
    expectSessionEndedOnce();
    expect(latest.current?.user).toBeNull();
    unmount();
  });

  it('says "not deleted" after a 401 when the session is still alive', async () => {
    state.deleteAccount.mockRejectedValue(sessionRefused);
    state.probe.mockResolvedValue('alive');
    const { latest, unmount } = await mountWith(registeredSession);

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.deleteAccount().catch((thrown: unknown) => {
        failure = thrown;
      });
    });
    await flush();

    expect(failure).toBe(sessionRefused);
    expectSessionKept();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    expect(latest.current?.user?.id).toBe('user-1');
    unmount();
  });

  it.each([
    ['no clean answer', 'unknown'],
    ['a refusal that names no ended session', 'refused'],
  ])('cannot confirm either way when Supabase gives %s, and keeps the session', async (_name, verdict) => {
    state.deleteAccount.mockRejectedValue(platformFailure);
    state.probe.mockResolvedValue(verdict);
    const { latest, unmount } = await mountWith(registeredSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('unconfirmed');
    expectSessionKept();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    expect(latest.current?.user?.id).toBe('user-1');
    unmount();
  });
});

describe('the sign-in that confirms a deletion', () => {
  it('fails as a reauthentication failure naming its method, before anything is asked of the server', async () => {
    const refused = Object.assign(new Error('Invalid login credentials'), { status: 400 });
    state.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: refused });
    const { latest, unmount } = await mountWith(registeredSession);

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.deleteAccount({ method: 'password', password: 'wrong-Horse-1' }).catch((thrown: unknown) => {
        failure = thrown;
      });
    });

    expect(failure).toBeInstanceOf(AccountReauthenticationFailedError);
    expect((failure as AccountReauthenticationFailedError).method).toBe('password');
    expect((failure as AccountReauthenticationFailedError).failure).toBe(refused);
    expect(state.deleteAccount).not.toHaveBeenCalled();
    expectSessionKept();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    unmount();
  });

  // Audit 04-6: the mismatch path left the device with no session at all
  // until the next launch, and kept the creator caches.
  it('drops back to a fresh guest, with the teardown every way out shares, when it lands on another account', async () => {
    const otherSession = sessionFor({ id: 'user-2', email: 'someone@example.com' }, 'other-token');
    state.signInWithPassword.mockImplementation(async () => {
      state.authCallback?.('SIGNED_IN', otherSession);
      return { data: { session: otherSession, user: otherSession.user }, error: null };
    });
    const { latest, unmount } = await mountWith(registeredSession);
    // What the reauthentication reads back: the account the sign-in landed on.
    state.getSession.mockResolvedValueOnce({ data: { session: otherSession }, error: null });

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.deleteAccount({ method: 'password', password: 'correct-Horse-1' }).catch((thrown: unknown) => {
        failure = thrown;
      });
    });
    await flush();

    expect(failure).toBeInstanceOf(AccountReauthenticationAccountMismatchError);
    expect(state.deleteAccount).not.toHaveBeenCalled();
    expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.clearHomeFeed).toHaveBeenCalledOnce();
    expect(state.clearSearchHistory).toHaveBeenCalledOnce();
    // The account it started from had registered this phone for push.
    expect(state.clearLocalPush).toHaveBeenCalledOnce();
    expect(state.queryClient.removeQueries).toHaveBeenCalledOnce();
    const [{ predicate }] = state.queryClient.removeQueries.mock.calls[0] as [{
      predicate: (query: { queryKey: readonly unknown[] }) => boolean;
    }];
    expect(predicate({ queryKey: ['creator-profile', 'infinite', 'luna'] })).toBe(true);
    expect(predicate({ queryKey: ['creator-follow-state', 'creator-7'] })).toBe(true);
    expect(state.signInAnonymously).toHaveBeenCalledOnce();
    expect(latest.current?.user).toBeNull();
    expect(latest.current?.identityUserId).toBe('guest-2');
    expect(state.replace).toHaveBeenCalledWith('/auth');
    unmount();
  });
});

// Audit 04-2: the guard was keyed by the user id and never cleared, so signing
// in again to the account before the server had removed it left every screen
// failing with "being permanently deleted" for up to an hour.
describe('signing in again to an account that is being deleted', () => {
  it('ends the fresh session at its next 409, and says why, rather than ignoring it', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(registeredSession);
    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();
    expect(latest.current?.identityUserId).toBe('guest-2');

    const freshSession = sessionFor({ id: 'user-1', email: 'creator@example.com' }, 'fresh-sign-in-token');
    state.signInWithPassword.mockImplementation(async () => {
      state.authCallback?.('SIGNED_IN', freshSession);
      return { data: { session: freshSession, user: freshSession.user }, error: null };
    });
    await renderer.act(async () => {
      await latest.current?.signInWithPassword('creator@example.com', 'correct-Horse-1');
    });
    await flush();
    expect(latest.current?.user?.id).toBe('user-1');

    let ended: unknown;
    await renderer.act(async () => {
      ended = await latest.current?.leaveDeletingAccount();
    });
    await flush();

    // True is what has the layout show ACCOUNT_DELETION_SCHEDULED_NOTICE.
    expect(ended).toBe(true);
    expect(latest.current?.user).toBeNull();
    expect(state.clearPersistedSession).toHaveBeenCalledTimes(2);
    expect(state.dismissTo).toHaveBeenCalledTimes(2);
    unmount();
  });
});

// Audit 04-7: the deletion promises the account's private creations and
// uploaded media go, and copies of its prompts and staged media stayed here.
describe("what a deleted account left in drafts on this phone", () => {
  it('goes with it, and so does what the guest it was made from left', async () => {
    const accountSession = sessionFor({ id: 'user-1', email: 'creator@example.com' }, 'deleting-token');
    state.signInWithPassword.mockImplementation(async () => {
      state.authCallback?.('SIGNED_IN', accountSession);
      return { data: { session: accountSession, user: accountSession.user }, error: null };
    });
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(guestSession);
    await renderer.act(async () => {
      await latest.current?.signInWithPassword('creator@example.com', 'correct-Horse-1');
    });
    await flush();

    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();

    for (const clear of [state.clearCreationDrafts, state.clearComposerDrafts, state.clearGenerationAttempt]) {
      expect(clear.mock.calls).toEqual([['user-1'], ['guest-1']]);
    }
    unmount();
  });

  it('goes when another device deleted the account (409 ACCOUNT_DELETING)', async () => {
    const { latest, unmount } = await mountWith(registeredSession);

    await renderer.act(async () => {
      await latest.current?.leaveDeletingAccount();
    });
    await flush();

    for (const clear of [state.clearCreationDrafts, state.clearComposerDrafts, state.clearGenerationAttempt]) {
      expect(clear.mock.calls).toEqual([['user-1']]);
    }
    unmount();
  });

  it('stays when the answer left the account untouched', async () => {
    state.deleteAccount.mockRejectedValue(notStarted);
    const { latest, unmount } = await mountWith(registeredSession);

    await renderer.act(async () => {
      await latest.current?.deleteAccount().catch(() => undefined);
    });
    await flush();

    expect(state.clearCreationDrafts).not.toHaveBeenCalled();
    expect(state.clearComposerDrafts).not.toHaveBeenCalled();
    expect(state.clearGenerationAttempt).not.toHaveBeenCalled();
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

  // A guest's deletion (D5) is asked for on this phone, and ends the session itself.
  it('leaves a guest alone', async () => {
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

// D5 (C2): a guest deletes itself and what it made, from Settings, with the
// request an account sends and no sign-in first; the phone carries on as a
// fresh guest on Home.
describe("deleting a guest's data from this phone (D5)", () => {
  function expectGuestDeletedOnce() {
    expect(state.clearPersistedSession).toHaveBeenCalledOnce();
    expect(state.clearHomeFeed).toHaveBeenCalledOnce();
    expect(state.clearSearchHistory).toHaveBeenCalledOnce();
    expect(state.queryClient.clear).toHaveBeenCalledOnce();
    expect(state.signInAnonymously).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledOnce();
    expect(state.dismissTo).toHaveBeenCalledWith('/');
    expect(state.replace).not.toHaveBeenCalled();
    // Nothing is asked of Supabase: the deletion revoked the guest's sessions.
    expect(state.signOut).not.toHaveBeenCalled();
    // A guest never registered this phone for push.
    expect(state.clearLocalPush).not.toHaveBeenCalled();
  }

  it.each([
    ['scheduled it (202)', { success: true, deleted: false, deletionScheduled: true }, 'scheduled'],
    ['had finished it already (200)', { success: true, deleted: true, cleanupPending: false, alreadyDeleted: true }, 'deleted'],
  ])('sends the request an account sends, with no sign-in, and ends as a deletion does once the server %s', async (_name, answer, expected) => {
    state.deleteAccount.mockResolvedValue(answer);
    const { latest, unmount } = await mountWith(guestSession);
    expect(latest.current?.isGuest).toBe(true);
    expect(latest.current?.accountReauthenticationMethods).toEqual([]);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe(expected);
    expect(state.deleteAccount).toHaveBeenCalledOnce();
    expect(state.deleteAccount).toHaveBeenCalledWith('DELETE', {});
    expect(state.signInWithPassword).not.toHaveBeenCalled();
    expectGuestDeletedOnce();
    // What it left in drafts on this phone goes with it.
    for (const clear of [state.clearCreationDrafts, state.clearComposerDrafts, state.clearGenerationAttempt]) {
      expect(clear.mock.calls).toEqual([['guest-1']]);
    }
    // A guest is no account: the tickets an account could redeem, and what an
    // account's links came to, are not its to take.
    expect(state.forgetGuestMergeTickets).not.toHaveBeenCalled();
    expect(state.clearGuestMergeOutcome).not.toHaveBeenCalled();
    expect(state.feedTransition.commit).toHaveBeenCalledOnce();
    expect(latest.current?.user).toBeNull();
    expect(latest.current?.isGuest).toBe(true);
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });

  it('forgets the tickets kept for that guest, and no other', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    state.readGuestMergeTickets.mockResolvedValue([
      { ticket: 'b'.repeat(64), guestUserId: 'guest-1', redeemedForUserId: null, expiresAt: null },
      { ticket: 'c'.repeat(64), guestUserId: 'guest-0', redeemedForUserId: null, expiresAt: null },
      { ticket: 'd'.repeat(64), guestUserId: null, redeemedForUserId: null, expiresAt: null },
    ]);
    const { latest, unmount } = await mountWith(guestSession);

    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();

    expect(state.removeGuestMergeTicket.mock.calls).toEqual([['b'.repeat(64)]]);
    unmount();
  });

  it('never signs in for a guest, even when a sign-in is passed', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(guestSession);

    await renderer.act(async () => {
      await latest.current?.deleteAccount({ method: 'password', password: 'correct-Horse-1' });
    });
    await flush();

    expect(state.signInWithPassword).not.toHaveBeenCalled();
    expect(state.deleteAccount).toHaveBeenCalledWith('DELETE', {});
    expectGuestDeletedOnce();
    unmount();
  });

  it.each([
    ['a server from before guests could delete their data (403)', registrationRequired],
    ['a 500 that says nothing was started', notStarted],
    ['a rate limit', rateLimited],
    ['a request given up before it left the phone', neverSent],
  ])('keeps the guest and its session after %s', async (_name, error) => {
    state.deleteAccount.mockRejectedValue(error);
    const { latest, unmount } = await mountWith(guestSession);

    let failure: unknown;
    await renderer.act(async () => {
      await latest.current?.deleteAccount().catch((thrown: unknown) => {
        failure = thrown;
      });
    });
    await flush();

    expect(failure).toBe(error);
    expectSessionKept();
    expect(state.probe).not.toHaveBeenCalled();
    expect(state.removeGuestMergeTicket).not.toHaveBeenCalled();
    expect(state.feedTransition.cancel).toHaveBeenCalledOnce();
    expect(latest.current?.identityUserId).toBe('guest-1');
    unmount();
  });

  it("asks Supabase about the guest's own token when the answer is lost, and ends it once that session is gone", async () => {
    state.deleteAccount.mockRejectedValue(offline);
    state.probe.mockResolvedValue('ended');
    const { latest, unmount } = await mountWith(guestSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(state.probe).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'guest-token' }));
    expect(outcome).toBe('scheduled');
    expectGuestDeletedOnce();
    unmount();
  });

  it('keeps the guest when Supabase cannot say either way', async () => {
    state.deleteAccount.mockRejectedValue(platformFailure);
    state.probe.mockResolvedValue('unknown');
    const { latest, unmount } = await mountWith(guestSession);

    let outcome: unknown;
    await renderer.act(async () => {
      outcome = await latest.current?.deleteAccount();
    });
    await flush();

    expect(outcome).toBe('unconfirmed');
    expectSessionKept();
    expect(latest.current?.identityUserId).toBe('guest-1');
    unmount();
  });

  // The fresh guest is the only identity on the phone by then.
  it('leaves the fresh guest alone when a refusal of the deleted guest comes back late (409 ACCOUNT_DELETING)', async () => {
    state.deleteAccount.mockResolvedValue({ success: true, deleted: false, deletionScheduled: true });
    const { latest, unmount } = await mountWith(guestSession);
    await renderer.act(async () => {
      await latest.current?.deleteAccount();
    });
    await flush();
    expect(latest.current?.identityUserId).toBe('guest-2');

    let ended: unknown;
    await renderer.act(async () => {
      ended = await latest.current?.leaveDeletingAccount();
    });
    await flush();

    expect(ended).toBe(false);
    expectGuestDeletedOnce();
    expect(latest.current?.identityUserId).toBe('guest-2');
    unmount();
  });

  // The confirmation was drawn for the guest; the request carries whatever
  // session the device holds when it leaves, and an account's must never go.
  it('asks nothing when the phone has moved to an account since the guest confirmed', async () => {
    const { latest, unmount } = await mountWith(guestSession);
    const confirmedAsGuest = latest.current?.deleteAccount;
    await renderer.act(async () => {
      state.authCallback?.('SIGNED_IN', registeredSession);
    });
    await flush();
    expect(latest.current?.user?.id).toBe('user-1');

    let failure: unknown;
    await renderer.act(async () => {
      await confirmedAsGuest?.().catch((thrown: unknown) => {
        failure = thrown;
      });
    });

    expect((failure as Error).message).toBe('This phone has moved to another session.');
    expect(state.deleteAccount).not.toHaveBeenCalled();
    expect(state.clearPersistedSession).not.toHaveBeenCalled();
    expect(latest.current?.user?.id).toBe('user-1');
    unmount();
  });

  it('asks nothing of a phone with no session at all', async () => {
    const { latest, unmount } = await mountWith(null);

    await renderer.act(async () => {
      await expect(latest.current?.deleteAccount()).rejects.toThrow('Sign in before deleting your account.');
    });

    expect(state.deleteAccount).not.toHaveBeenCalled();
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

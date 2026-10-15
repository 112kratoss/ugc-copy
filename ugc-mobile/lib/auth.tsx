import type { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { router, usePathname } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { env, getMissingMobileEnvKeys } from './env';
import {
  combineGuestMergeOutcomes,
  GUEST_MERGE_TICKET_MIN_VALIDITY_MS,
  GUEST_MERGE_TICKET_RENEW_WITHIN_MS,
  guestMergeOutcomeOf,
  keptGuestMergeTicketFor,
  resolveMergeRedeemAction,
  resolveMergeRedeemFailureAction,
  shouldPrepareGuestMerge,
  ticketsRedeemableFor,
  type GuestMergeOutcome,
  type GuestMergeState,
} from './guest-merge';
import {
  bindGuestMergeTicket,
  clearGuestMergeOutcome,
  forgetGuestMergeTicketsFor,
  readGuestMergeOutcome,
  readGuestMergeTickets,
  removeGuestMergeTicket,
  storeGuestMergeOutcome,
  storeGuestMergeTicket,
  type KeptGuestMergeOutcome,
} from './guest-merge-ticket-storage';
import { getRegisteredUser, isGuestSession } from './guest-session';
import { signInWithNativeApple } from './apple-auth';
import { signInWithGoogleOAuth } from './google-auth';
import {
  AccountReauthenticationAccountMismatchError,
  AccountReauthenticationFailedError,
  getAccountReauthenticationMethods,
  reauthenticateAccountForDeletion,
  type AccountDeletionReauthentication,
  type AccountReauthenticationMethod,
} from './account-reauthentication';
import { GUEST_MERGE_PREPARE_ERROR_CODE } from './auth-error-copy';
import { normalizeAuthReturnTo } from './auth-navigation';
import {
  ACCOUNT_DELETING_CODE,
  ApiError,
  createApiClient,
  isRequestTimeoutError,
  type MagicbookletApiClient,
} from './api-client';
import { clearCreationDraftsForUser } from './creation-draft-resume';
import { getFeedInstallationId } from './feed-installation-id';
import {
  beginShowcaseFeedEventIdentityTransition,
  configureFeedEventQueue,
  flushShowcaseFeedEvents,
  restoreShowcaseFeedEvents,
} from './feed-event-queue';
import { clearGenerationAttemptForUser } from './generation-attempts';
import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION } from './generation-model-catalog';
import { claimPendingReferral } from './referral-attribution';
import {
  clearLocalMobilePushRegistration,
  registerForMobilePushNotifications,
  subscribeToMobilePushTokenChanges,
  unregisterMobilePushNotifications,
} from './notifications';
import {
  clearPersistedAccountState,
  persistAccountStateOnChange,
  restorePersistedAccountState,
} from './persisted-account-state';
import { clearPersistedHomeFeed } from './persisted-home-feed';
import { clearComposerDraftsForUser } from './post-composer-draft-resume';
import { devicePushQueryKey } from './push-registration';
import { clearSearchHistory } from './search-history';
import {
  clearPersistedSupabaseAuthSession,
  duringSignOut,
  initializeSupabaseAuth,
  isSupabaseConfigured,
  readPersistedSupabaseSession,
  supabase,
} from './supabase';
import {
  isInvalidRefreshTokenError,
  isRetryableRefreshError,
  isSessionEndedRefreshError,
  normalizeSupabaseAuthError,
} from './supabase-auth-recovery';
import { probeSupabaseSession } from './supabase-session-probe';

export type AuthMode = 'login' | 'signup';
export type {
  AccountDeletionReauthentication,
  AccountReauthenticationMethod,
} from './account-reauthentication';
export {
  AccountReauthenticationFailedError,
  getAccountReauthenticationMethods,
} from './account-reauthentication';

interface AuthContextValue {
  session: Session | null;
  /**
   * The registered account, or null.
   *
   * Deliberately null for guests even though a guest holds a real Supabase
   * session. Roughly seventy `!user` checks across this app mean "is this
   * person registered?" — they gate publishing, comments, follows, the
   * marketplace and payouts. Letting an anonymous session flow through here
   * would open all of them at once. Surfaces that should serve guests read
   * `isGuest` / `identityUserId` instead, and opt in one at a time.
   */
  user: User | null;
  /** True when the backend identity is an anonymous (guest) session. */
  isGuest: boolean;
  /** The backend user id for guests and registered users alike. */
  identityUserId: string | null;
  /** Lifecycle of the guest->account link. `pending` survives app restarts. */
  mergeState: GuestMergeState;
  /**
   * What linking guest identities to the account signed in came to (audit
   * 02-8): the credits it moved, or why it moved none. Kept on the device
   * until dismissed, shown to that account only; null when there is nothing
   * to say.
   */
  guestMergeOutcome: GuestMergeOutcome | null;
  /** Dismisses the outcome, on this device. The tickets are untouched. */
  dismissGuestMergeOutcome: () => void;
  /**
   * Keeps a merge ticket for the guest on this device, minting one when none is
   * kept for it (audit 02-7). Called once a guest holds something worth
   * carrying to an account: credits, a creation. A no-op for a registered
   * session. Never rejects.
   */
  ensureGuestMergeTicket: () => Promise<void>;
  /**
   * Records "Set up later" on the account, in the user metadata the web reads,
   * so the choice holds on every device (audit 02-11). A no-op for a guest.
   * Never rejects.
   */
  markIdentityDeferredOnAccount: () => Promise<void>;
  credits: number | null;
  /**
   * When `credits` was last set from the server (a profile read, a link) or by
   * a spend or purchase this app made, in epoch ms; null until then.
   */
  creditsUpdatedAt: number | null;
  isLoading: boolean;
  isAuthConfigured: boolean;
  missingEnvKeys: string[];
  api: MagicbookletApiClient;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInWithApple: (mode: AuthMode) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Signs out. A call made while one is already running joins that one. */
  signOut: () => Promise<void>;
  /** True from the start of a sign-out until it has finished or failed. */
  isSigningOut: boolean;
  /**
   * Drops a guest session the server has told us is spent (409 SESSION_MERGED)
   * and leaves the device on a fresh guest, ready to sign in.
   */
  abandonMergedGuestSession: () => Promise<void>;
  /**
   * Checks a session the server refused (401) with Supabase and, if it has
   * ended, signs this device out locally and leaves it on a fresh guest.
   */
  recoverRejectedSession: () => Promise<void>;
  /**
   * Ends this device's session on an account the server is deleting (409
   * ACCOUNT_DELETING) and leaves it on Home as a fresh guest. Resolves true
   * when it did, so the caller can say why; false when there was nothing to
   * end, or when a deletion asked for on this phone is ending it already.
   */
  leaveDeletingAccount: () => Promise<boolean>;
  accountReauthenticationMethods: AccountReauthenticationMethod[];
  /**
   * Deletes the account. Once the server has it, this device is signed out
   * and left on Home as a fresh guest, and the promise says how far the server
   * got: `scheduled` (locked and signed out everywhere, the rest under way) or
   * `deleted` (finished before this request). `unconfirmed` when the answer was
   * lost and Supabase could not say either way: this device stays signed in.
   * Rejects only when the account was not touched, or when the person must
   * sign in again first (an `AccountReauthenticationFailedError` when the
   * sign-in this device asked for failed).
   */
  deleteAccount: (reauthentication?: AccountDeletionReauthentication) => Promise<AccountDeletionOutcome>;
  refreshProfile: () => Promise<void>;
  updateCredits: (credits: number | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_ACCESS_TOKEN_MIN_TTL_MS = 30 * 1000;
// Push unregistration is best-effort, so sign-out stops waiting for it well
// before the API client's own 30 s request timeout.
const SIGN_OUT_PUSH_UNREGISTER_DEADLINE_MS = 10 * 1000;

export { getRegisteredUser, isGuestSession } from './guest-session';
export type { GuestMergeOutcome } from './guest-merge';

/**
 * A guest bootstrap that failed is tried again after 5 s, 30 s and 2 min, then
 * every 5 min (audit 02-6). A launch offline, anonymous sign-ups over the
 * per-IP limit, a refused refresh token: buying without an account needs this
 * identity, and nothing short of a cold restart used to try again.
 */
export const GUEST_BOOTSTRAP_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000] as const;

/** The wait before the next attempt, after `failures` failed attempts in a row. */
export function guestBootstrapRetryDelayMs(failures: number) {
  const step = Math.min(Math.max(failures, 1), GUEST_BOOTSTRAP_RETRY_DELAYS_MS.length) - 1;
  return GUEST_BOOTSTRAP_RETRY_DELAYS_MS[step];
}

/**
 * The balance is read again when the app comes back to the foreground, at most
 * this often (audit 03-4): a purchase settled by a store webhook or on the web,
 * and a referral reward, all land while the app is away.
 */
export const RESUME_PROFILE_REFRESH_INTERVAL_MS = 30_000;

/** The web's record of "Set up later": its `user_metadata` key and version (src/lib/auth-onboarding.ts). */
export const IDENTITY_DEFERRED_METADATA_KEY = 'creator_profile_onboarding_skipped_version';
export const IDENTITY_DEFERRED_METADATA_VERSION = 1;

/**
 * Whether the account has "Set up later" on record, made on the web or in this
 * app (audit 02-11), read the way the web reads it.
 */
export function isIdentityDeferredOnAccount(user: Pick<User, 'user_metadata'> | null | undefined) {
  const metadata: unknown = user?.user_metadata;
  if (typeof metadata !== 'object' || metadata === null) return false;
  const version = (metadata as Record<string, unknown>)[IDENTITY_DEFERRED_METADATA_KEY];
  return typeof version === 'number' && version >= IDENTITY_DEFERRED_METADATA_VERSION;
}

export type AccountDeletionOutcome = 'deleted' | 'scheduled' | 'unconfirmed';

/** What the app says once an account it was signed in to is being deleted. */
export const ACCOUNT_DELETION_SCHEDULED_NOTICE = {
  title: 'Your account is being deleted',
  message: 'You have been signed out.',
} as const;

function apiErrorDetail(error: ApiError, key: string): unknown {
  return typeof error.details === 'object' && error.details !== null
    ? (error.details as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A deletion refused until the person signs in again. The server marks each
 * such refusal with `reason`; the legacy codes it still sends beside it keep
 * this true against a server from before the marker.
 */
export function isAccountReauthenticationRequired(error: unknown) {
  return error instanceof ApiError
    && (apiErrorDetail(error, 'reason') === 'reauthentication_required'
      || error.code === 'RECENT_AUTH_REQUIRED'
      || error.code === 'APPLE_REAUTH_REQUIRED');
}

function hasJsonBody(error: ApiError) {
  return typeof error.details === 'object' && error.details !== null;
}

/**
 * Whether a deletion request that did not come back a success started the
 * deletion all the same, which nothing can undo:
 * - 409 ACCOUNT_DELETING: the account is being deleted already.
 * - the route's own 500: only `deletionScheduled: false` means nothing was
 *   touched (the server could not start). Its other 500 comes after the account
 *   was locked, and its scheduler finishes the job.
 * - this app's own deadline: the request had been sent, and the server goes on
 *   with it whether or not anyone waits for the answer.
 */
export function isAccountDeletionUnderway(error: unknown) {
  if (isRequestTimeoutError(error)) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.status === 409) return error.code === ACCOUNT_DELETING_CODE;
  if (error.status === 500 && hasJsonBody(error)) return apiErrorDetail(error, 'deletionScheduled') !== false;
  return false;
}

/**
 * An answer that cannot say whether the deletion started (audit 04-3): a
 * connection lost after the request may have left (status 0 other than this
 * app's own deadline), a 401 (the deletion revokes every session as soon as it
 * starts, so a retry, or a request beside it, is refused), and a server failure
 * with no JSON, which the platform gave before or after the route ran. Supabase
 * is asked about the session the request carried instead of guessing.
 */
export function isAmbiguousAccountDeletionAnswer(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  // A request given up while it waited for its session token never left the
  // phone (`sent: false`, which isRequestTimeoutError also reads): nothing
  // happened on the server, so it is a plain "not deleted".
  if (error.status === 0) return !isRequestTimeoutError(error) && apiErrorDetail(error, 'sent') !== false;
  if (error.status === 401) return true;
  return error.status >= 500 && !hasJsonBody(error);
}

/**
 * Asks Supabase about the session a deletion request carried, when the answer
 * could not say whether the deletion started (audit 04-3). The deletion revokes
 * every session of the account as soon as it starts, so a session that is gone
 * means it started, and a live one means it did not. Anything else, the probe
 * failing included, proves nothing: null.
 */
async function deletionStartedOnServer(accessToken: string | null): Promise<boolean | null> {
  if (!accessToken) return null;
  const verdict = await probeSupabaseSession({
    supabaseUrl: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    accessToken,
  });
  if (verdict === 'ended') return true;
  if (verdict === 'alive') return false;
  return null;
}

/** Every way a session leaves this device; see tearDownLocalSession. */
type LocalSessionEndReason =
  | 'signed-out'
  | 'session-ended'
  | 'guest-merged'
  | 'account-deleted'
  | 'reauthentication-mismatch';

/** Creator pages and follow buttons, cached without the viewer in their key. */
function isViewerlessCreatorQuery(query: { queryKey: readonly unknown[] }) {
  return query.queryKey[0] === 'creator-profile' || query.queryKey[0] === 'creator-follow-state';
}

/**
 * The sign-in screen with the notice that says why the person is there, and
 * the route they were on to come back to once signed in: Home when it is not
 * known, or when it is the sign-in screen itself (audit 01-12).
 */
export function signInNoticeRoute(
  notice: 'signed-out' | 'session-merged',
  currentRoute: string | null | undefined,
) {
  const route = normalizeAuthReturnTo(currentRoute);
  const returnTo = route && !/^\/auth(?:[/?#]|$)/.test(route) ? route : '/(tabs)';
  return { pathname: '/auth', params: { notice, returnTo } } as const;
}

function getUsableCachedAccessToken(session: Session | null, now = Date.now()): string | null {
  if (!session?.access_token) return null;
  if (typeof session.expires_at !== 'number') return session.access_token;
  return session.expires_at * 1000 - now > CACHED_ACCESS_TOKEN_MIN_TTL_MS
    ? session.access_token
    : null;
}

async function unregisterPushBeforeSignOut(api: MagicbookletApiClient) {
  const deadline = new AbortController();
  const timeoutId = setTimeout(() => deadline.abort(), SIGN_OUT_PUSH_UNREGISTER_DEADLINE_MS);
  try {
    await unregisterMobilePushNotifications(api, { signal: deadline.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsUpdatedAt, setCreditsUpdatedAt] = useState<number | null>(null);
  // The balance on screen, for the foreground handler (see the resume effect).
  const creditsRef = useRef<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const signOutInFlightRef = useRef<Promise<void> | null>(null);
  const queryClient = useQueryClient();
  const missingEnvKeys = useMemo(() => getMissingMobileEnvKeys(), []);
  const sessionUserIdRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  // The guest bootstrap under way, and its retry after a failure (audit 02-6):
  // failed attempts in a row, the time before which only a foreground return
  // tries again, and the timer that tries then.
  const guestBootstrapRef = useRef<Promise<void> | null>(null);
  const guestBootstrapFailuresRef = useRef(0);
  const guestBootstrapRetryAtRef = useRef(0);
  const guestBootstrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // False while the provider's effects are stopped (unmounted, or hidden by an
  // <Activity>): no retry timer is armed then, and the effect arms it again.
  const guestBootstrapActiveRef = useRef(true);
  // Sign-ins under way. A guest bootstrap does not start beside one: the
  // anonymous session it made could land after the account's and replace it.
  const signInsInFlightRef = useRef(0);
  const rejectedSessionRecoveryRef = useRef<Promise<void> | null>(null);
  // A deletion asked for on this phone owns the session's end, whatever other
  // requests are told meanwhile.
  const accountDeletionInFlightRef = useRef(false);
  // The access token of the session this device has already ended for a
  // deletion. It is refused everywhere afterwards (401 or 409), and none of
  // those refusals may end the session, or move the person, a second time.
  // Keyed by the session, not the account: a fresh sign-in to the same account
  // before the server has removed it is refused too, and must be ended in its
  // turn rather than ignored (audit 04-2).
  const endedDeletionSessionTokenRef = useRef<string | null>(null);
  // Guest identities this run signed in from, by the account they went into, so
  // deleting that account also clears what the guest left on the phone.
  const linkedGuestUserIdsRef = useRef(new Map<string, Set<string>>());
  // The route on screen, published by CurrentRouteTracker below, so a forced
  // sign-out can send the person back to it after signing in (audit 01-12).
  const currentRouteRef = useRef<string | null>(null);
  const [mergeState, setMergeState] = useState<GuestMergeState>('idle');
  // The link outcome kept until dismissed, with the account it is for. The ref
  // is `undefined` until the copy on the device has been read or replaced.
  const [keptMergeOutcome, setKeptMergeOutcome] = useState<KeptGuestMergeOutcome | null>(null);
  const keptMergeOutcomeRef = useRef<KeptGuestMergeOutcome | null | undefined>(undefined);
  const mergeOutcomeLoadRef = useRef<Promise<void> | null>(null);
  // One redemption run at a time, and one ticket mint per guest.
  const guestMergeRedemptionRef = useRef<Promise<void> | null>(null);
  const guestTicketMintsRef = useRef(new Map<string, Promise<void>>());
  const authStateVersionRef = useRef(0);
  const profileRefreshRef = useRef<{ promise: Promise<void>; userId: string; version: number } | null>(null);
  // When the last profile read started, which paces the one on a foreground return.
  const lastProfileRefreshAtRef = useRef(0);
  // How many times this app has set the balance from an answer of its own (a
  // spend, a purchase, a link). A profile read that set out before the last of
  // them carries an older balance, and does not replace it.
  const creditsMovedHereRef = useRef(0);
  // The auth version whose balance has come from the server, or from a spend or
  // purchase this app made. The copy saved on the device never overwrites that.
  const creditsSettledVersionRef = useRef(-1);

  // Puts the balance this account last showed back on screen while the profile
  // refresh fetches a fresh one. The saved copy is read off the device at launch
  // (see app/_layout.tsx), so this usually resolves at once.
  const restoreAccountState = useCallback((userId: string, version: number) => {
    void restorePersistedAccountState(queryClient, { userId })
      .then((restored) => {
        if (!restored) return;
        // The server, or a spend, answered first: what it said stands.
        if (authStateVersionRef.current !== version || creditsSettledVersionRef.current === version) return;
        setCredits(restored.credits);
      });
  }, [queryClient]);

  const applySessionState = useCallback((nextSession: Session | null) => {
    const nextUserId = nextSession?.user?.id ?? null;
    const userChanged = sessionUserIdRef.current !== nextUserId;
    if (userChanged) {
      authStateVersionRef.current += 1;
      profileRefreshRef.current = null;
    }
    sessionUserIdRef.current = nextUserId;
    sessionRef.current = nextSession;
    setSession(nextSession);
    if (userChanged || !nextUserId) {
      setCredits(null);
      setCreditsUpdatedAt(null);
    }
    if (nextSession) {
      // A session in hand ends any wait for a guest one (audit 02-6).
      guestBootstrapFailuresRef.current = 0;
      guestBootstrapRetryAtRef.current = 0;
      if (guestBootstrapTimerRef.current) clearTimeout(guestBootstrapTimerRef.current);
      guestBootstrapTimerRef.current = null;
    }
    // A launch or a sign-in: the numbers this account last showed go back on
    // screen while the profile refresh fetches fresh ones.
    if (userChanged && nextUserId) restoreAccountState(nextUserId, authStateVersionRef.current);
    // Navigation can continue from the persisted local session. Profile and
    // credit data refresh independently in the background.
    setIsLoading(false);
  }, [restoreAccountState]);

  const resetAuthState = useCallback(() => {
    applySessionState(null);
  }, [applySessionState]);

  /**
   * Give this device a backend identity without asking for anything.
   *
   * This is what App Review 5.1.1(v) required: a buyer must be able to purchase
   * credits without registering, and credits are a server-side balance, so the
   * balance needs somewhere to live. An anonymous Supabase user is a real
   * auth.users row, so every existing endpoint — purchase sync, the credit
   * ledger, generation — works against it unchanged.
   *
   * Failure is not fatal and must never be. If anonymous sign-ins are disabled
   * on the project, or the device is offline, the app falls back to exactly the
   * behaviour it had before guests existed: signed out, with sign-in prompts on
   * the surfaces that need an account. A hard failure here would leave a
   * first-launch user staring at a dead app.
   *
   * A failure is tried again while the app runs (audit 02-6): by a timer, after
   * 5 s, 30 s and 2 min and then every 5 min; at once on a return to the
   * foreground; and by a request that finds no session, once the wait is over
   * (`whenDue`). Attempts never overlap.
   */
  const ensureGuestSession = useCallback((options: { whenDue?: boolean } = {}): Promise<void> => {
    const attempt = (whenDue: boolean): Promise<void> => {
      if (!isSupabaseConfigured) return Promise.resolve();
      if (guestBootstrapRef.current) return guestBootstrapRef.current;

      const retryLater = (delayMs: number) => {
        guestBootstrapRetryAtRef.current = Date.now() + delayMs;
        if (guestBootstrapTimerRef.current) clearTimeout(guestBootstrapTimerRef.current);
        guestBootstrapTimerRef.current = null;
        if (!guestBootstrapActiveRef.current) return;
        guestBootstrapTimerRef.current = setTimeout(() => {
          guestBootstrapTimerRef.current = null;
          void attempt(true);
        }, delayMs);
      };

      const waitMs = guestBootstrapRetryAtRef.current - Date.now();
      if (whenDue && waitMs > 0) {
        // Not yet. The timer waiting for that moment takes it, armed again here
        // if an effect cleanup has cleared it.
        if (!guestBootstrapTimerRef.current) retryLater(waitMs);
        return Promise.resolve();
      }
      if (guestBootstrapTimerRef.current) clearTimeout(guestBootstrapTimerRef.current);
      guestBootstrapTimerRef.current = null;

      const bootstrap = (async () => {
        try {
          await initializeSupabaseAuth();
          const { data, error } = await supabase.auth.getSession();
          if (error) throw error;
          if (!data.session) {
            // A sign-in under way gives this device its session. Should it fail,
            // the retry after the shortest wait finds none and starts a guest.
            if (signInsInFlightRef.current > 0) {
              retryLater(GUEST_BOOTSTRAP_RETRY_DELAYS_MS[0]);
              return;
            }
            // Drain events recorded while fully signed out before replacing the
            // installation identity with a Supabase guest. Installation-scoped
            // entries remain sendable after the transition if this best-effort
            // flush has to back off.
            void flushShowcaseFeedEvents();
            const { data: guest, error: guestError } = await supabase.auth.signInAnonymously();
            if (guestError) throw guestError;
            if (!guest.session) throw new Error('The guest sign-in returned no session.');
            applySessionState(guest.session);
          }
          guestBootstrapFailuresRef.current = 0;
          guestBootstrapRetryAtRef.current = 0;
        } catch (error) {
          console.warn('Could not start a guest session; continuing signed out', error);
          guestBootstrapFailuresRef.current += 1;
          retryLater(guestBootstrapRetryDelayMs(guestBootstrapFailuresRef.current));
        }
      })();
      guestBootstrapRef.current = bootstrap.finally(() => {
        guestBootstrapRef.current = null;
      });
      return guestBootstrapRef.current;
    };
    return attempt(options.whenDue === true);
  }, [applySessionState]);

  const getAccessToken = useCallback(async () => {
    if (!isSupabaseConfigured) {
      return null;
    }

    const cachedAccessToken = getUsableCachedAccessToken(sessionRef.current);
    if (cachedAccessToken) {
      return cachedAccessToken;
    }

    // Asked for a token with no session to give: the device has no identity at
    // all, so a guest bootstrap that failed is tried again, as often as its
    // backoff allows (audit 02-6). This request goes without one.
    try {
      await initializeSupabaseAuth();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        if (await recoverInvalidAuthSession(error)) {
          void ensureGuestSession({ whenDue: true });
          return null;
        }
        throw error;
      }
      sessionRef.current = data.session ?? null;
      if (!data.session) void ensureGuestSession({ whenDue: true });
      return data.session?.access_token ?? null;
    } catch (error) {
      if (await recoverInvalidAuthSession(error)) {
        void ensureGuestSession({ whenDue: true });
        return null;
      }
      throw error;
    }
  }, [ensureGuestSession]);

  const api = useMemo(
    () => createApiClient({
      baseUrl: env.apiBaseUrl,
      getAccessToken,
      getInstallationId: getFeedInstallationId,
      clientInfo: {
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        apiVersion: 1,
        catalogSchemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
      },
    }),
    [getAccessToken]
  );
  useEffect(() => {
    configureFeedEventQueue({
      api,
      getAccessToken,
      getIdentityUserId: () => sessionUserIdRef.current,
    });
    void restoreShowcaseFeedEvents();
    void flushShowcaseFeedEvents();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushShowcaseFeedEvents();
    });
    return () => subscription.remove();
  }, [api, getAccessToken, session?.user?.id]);
  const registeredUser = useMemo(() => getRegisteredUser(session), [session]);
  const isGuest = isGuestSession(session);
  const identityUserId = session?.user?.id ?? null;
  const accountReauthenticationMethods = useMemo(
    () => getAccountReauthenticationMethods(registeredUser),
    [registeredUser],
  );

  const refreshProfileForUser = useCallback((userId: string) => {
    const existing = profileRefreshRef.current;
    const version = authStateVersionRef.current;
    if (existing?.userId === userId && existing.version === version) return existing.promise;

    lastProfileRefreshAtRef.current = Date.now();
    const movesAtStart = creditsMovedHereRef.current;
    let promise: Promise<void>;
    promise = queryClient.fetchQuery({
      queryKey: ['profile', userId],
      queryFn: api.getProfile,
      // Explicit refreshes after purchases or generations must observe the
      // latest credit balance, while React Query still deduplicates in-flight
      // startup/profile requests that share this canonical key.
      staleTime: 0,
    })
      .then((profile) => {
        if (
          sessionUserIdRef.current === userId
          && authStateVersionRef.current === version
          && creditsMovedHereRef.current === movesAtStart
        ) {
          creditsSettledVersionRef.current = version;
          setCredits(profile.credits ?? null);
          setCreditsUpdatedAt(Date.now());
        }
      })
      .catch((error) => {
        console.warn('Failed to refresh profile after auth', error);
      })
      .finally(() => {
        if (profileRefreshRef.current?.promise === promise) {
          profileRefreshRef.current = null;
        }
      });
    profileRefreshRef.current = { promise, userId, version };
    return promise;
  }, [api, queryClient]);

  const refreshProfile = useCallback(async () => {
    if (!isSupabaseConfigured) {
      resetAuthState();
      return;
    }

    let userId = sessionUserIdRef.current;
    if (userId) {
      await refreshProfileForUser(userId);
      return;
    }

    try {
      await initializeSupabaseAuth();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        if (await recoverInvalidAuthSession(error)) {
          resetAuthState();
          return;
        }
        throw error;
      }
      const latestSession = data.session ?? null;
      applySessionState(latestSession);
      userId = latestSession?.user?.id ?? null;
    } catch (error) {
      if (await recoverInvalidAuthSession(error)) {
        resetAuthState();
        return;
      }
      console.warn('Failed to recover mobile auth session', error);
      resetAuthState();
      return;
    }

    if (!userId) {
      resetAuthState();
      return;
    }

    await refreshProfileForUser(userId);
  }, [applySessionState, refreshProfileForUser, resetAuthState]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }

    let active = true;
    // Whether auth-js has answered for this launch. Until it has, the session
    // stored on the device stands in (see readPersistedSupabaseSession below).
    let answered = false;
    let showingStoredSession = false;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION' && !nextSession && showingStoredSession && !answered) {
        // auth-js reports no initial session both when the stored one has ended
        // and when refreshing it failed on the network. It deletes the stored
        // session only in the first case, so storage tells the two apart.
        void readPersistedSupabaseSession()
          .catch(() => null)
          .then((stored) => {
            if (!active || answered || stored) return;
            answered = true;
            applySessionState(null);
          });
        return;
      }
      answered = true;
      applySessionState(nextSession ?? null);
      if (nextSession?.user) {
        void refreshProfileForUser(nextSession.user.id).catch((error) => {
          console.warn('Failed to refresh auth state', error);
        });
      }
    });

    // Lift the startup cover on the session this device already holds. auth-js
    // hands a session back only after refreshing an expired access token (a
    // network round trip on most launches more than an hour apart, retried for
    // up to 30 seconds on a bad connection), and the cover used to wait for it.
    // Nothing is sent any earlier for this: getAccessToken never sends an expired
    // token and waits on auth-js for a fresh one, so only what is drawn changes.
    void readPersistedSupabaseSession()
      .then((stored) => {
        if (!active || answered || !stored) return;
        showingStoredSession = true;
        applySessionState(stored);
      })
      .catch(() => undefined);

    void (async () => {
      try {
        await initializeSupabaseAuth();
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!active) return;
        answered = true;
        const latestSession = data.session ?? null;
        applySessionState(latestSession);
        if (latestSession?.user) {
          void refreshProfileForUser(latestSession.user.id).catch((profileError) => {
            console.warn('Failed to refresh hydrated profile', profileError);
          });
        } else {
          // No stored session: this is a first launch, a reinstall, or the tail
          // of a sign-out. Claim a guest identity now rather than at the
          // paywall, so the purchase screen never has to block on a network
          // round trip while someone is trying to pay.
          void ensureGuestSession();
        }
      } catch (error) {
        if (!active) return;
        if (await recoverInvalidAuthSession(error)) {
          answered = true;
          resetAuthState();
          // The stored session is gone for good: the device starts over as a
          // guest, as a first launch does, rather than with no identity at all
          // until its next cold start (audit 02-6).
          void ensureGuestSession();
          return;
        }
        // Refreshing the stored session failed on the network, and auth-js keeps
        // it and tries again. Keep showing it rather than dropping the person to
        // signed out until their next launch.
        if (showingStoredSession && isRetryableRefreshError(error)) {
          console.warn('Could not refresh the stored session yet; keeping it', error);
          return;
        }
        answered = true;
        console.warn('Failed to recover mobile auth session', error);
        resetAuthState();
      }
    })();

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [applySessionState, ensureGuestSession, refreshProfileForUser, resetAuthState]);

  useEffect(() => {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      return;
    }

    // Registered accounts only. A guest has no way to receive a notification
    // worth sending — no follows, no comments, no marketplace — and push tokens
    // registered against a guest row would be stranded the moment it merges.
    if (!registeredUser) {
      return;
    }

    const userId = registeredUser.id;
    const syncPushRegistration = () => queryClient.fetchQuery({
      queryKey: devicePushQueryKey(userId),
      queryFn: () => registerForMobilePushNotifications(api, { requestPermission: false }),
      staleTime: 1000 * 30,
    }).catch((error) => {
      console.error('Failed to register mobile push notifications', error);
    });

    void syncPushRegistration();
    const unsubscribePushTokenChanges = subscribeToMobilePushTokenChanges(api);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void syncPushRegistration();
      }
    });

    return () => {
      unsubscribePushTokenChanges();
      appStateSubscription.remove();
    };
  }, [api, queryClient, registeredUser]);

  // A balance this app moved itself, after a generation or a purchase. It is as
  // settled as a server answer, and the saved copy must not overwrite it either.
  const updateCredits = useCallback((nextCredits: number | null) => {
    creditsSettledVersionRef.current = authStateVersionRef.current;
    creditsMovedHereRef.current += 1;
    setCredits(nextCredits);
    setCreditsUpdatedAt(Date.now());
  }, []);

  useEffect(() => {
    creditsRef.current = credits;
  }, [credits]);

  // The balance follows every read of this identity's profile, not only the
  // refreshes made here: Home, Profile and the side menu read the same query,
  // and the balance kept here stayed behind what they had just fetched (audit
  // 03-4). Values written into the cache by hand (the saved copy, edits made in
  // place) are not reads, and are left out.
  useEffect(() => {
    if (!identityUserId) return;
    // The app's own balance changes counted when the read now landing set out.
    let movesAtReadStart = creditsMovedHereRef.current;
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const [scope, userId] = event.query.queryKey;
      if (scope !== 'profile' || userId !== identityUserId) return;
      if (event.action.type === 'fetch') {
        movesAtReadStart = creditsMovedHereRef.current;
        return;
      }
      if (event.action.type !== 'success' || event.action.manual) return;
      if (sessionUserIdRef.current !== identityUserId || creditsMovedHereRef.current !== movesAtReadStart) return;
      const profile = event.query.state.data as { credits?: number | null } | undefined;
      if (!profile) return;
      creditsSettledVersionRef.current = authStateVersionRef.current;
      setCredits(profile.credits ?? null);
      setCreditsUpdatedAt(event.query.state.dataUpdatedAt || Date.now());
    });
  }, [identityUserId, queryClient]);

  // Saves what the account shows — balance, profile, sales total, unread count —
  // whenever one of them settles, so the next launch can draw them before the
  // network answers. Cleared wherever the session leaves the device.
  useEffect(() => {
    if (!identityUserId) return;
    return persistAccountStateOnChange(queryClient, { userId: identityUserId, credits });
  }, [credits, identityUserId, queryClient]);

  useEffect(() => {
    // A referral reward is for signing up. Claiming it against a guest row
    // would burn the invite on an identity that has not registered yet.
    if (!registeredUser) return;

    void claimPendingReferral(api).catch((error) => {
      console.warn('Failed to claim pending referral after authentication', error);
    });
  }, [api, registeredUser]);

  /**
   * Keeps a merge ticket for the guest on this device (audit 02-7), minting one
   * when none is kept for it, or when the one kept is near its expiry.
   *
   * A guest's credits and creations exist nowhere but on its identity, and a
   * ticket used to be minted only at sign-in: a guest whose session ended first
   * (a refresh token refused, the bootstrap starting a fresh guest) took them
   * with it. Kept from the moment the guest holds something, the ticket moves
   * them onto the account at the next sign-in on this device.
   */
  const ensureGuestMergeTicket = useCallback((): Promise<void> => {
    const guestSession = sessionRef.current;
    const guestUserId = isGuestSession(guestSession) ? guestSession?.user?.id : null;
    if (!guestUserId) return Promise.resolve();
    const minting = guestTicketMintsRef.current.get(guestUserId);
    if (minting) return minting;

    const mint = (async () => {
      try {
        const kept = keptGuestMergeTicketFor(await readGuestMergeTickets(), guestUserId, {
          now: Date.now(),
          validForMs: GUEST_MERGE_TICKET_RENEW_WITHIN_MS,
        });
        if (kept) return;
        const { ticket, expiresAt } = await api.prepareGuestAccountMerge();
        // A sign-in that replaced this guest meanwhile kept a ticket of its own.
        if (sessionRef.current?.user?.id !== guestUserId) return;
        await storeGuestMergeTicket({ guestUserId, ticket, expiresAt: expiresAt ?? null });
      } catch (error) {
        console.warn('Could not keep a merge ticket for this guest yet', error);
      }
    })().finally(() => {
      guestTicketMintsRef.current.delete(guestUserId);
    });
    guestTicketMintsRef.current.set(guestUserId, mint);
    return mint;
  }, [api]);

  // From the moment a guest holds credits: a purchase, or a balance bought
  // before tickets were kept this way, read at launch.
  const guestHoldsCredits = isGuest && credits !== null && credits > 0;
  useEffect(() => {
    if (guestHoldsCredits) void ensureGuestMergeTicket();
  }, [ensureGuestMergeTicket, guestHoldsCredits, identityUserId]);

  /**
   * Mint and store the ticket that will carry this guest's credits across.
   *
   * Runs *before* authentication, while the guest session is still the caller.
   * Throws on failure, and the sign-in is abandoned as a result: continuing
   * would replace the only session that can prove ownership of the guest's
   * balance, with nothing held back to reclaim it. Losing purchased credits
   * silently is far worse than a sign-in the user can retry. The one exception
   * is a ticket kept for this guest since it first held credits, which carries
   * them just as well (audit 02-7).
   */
  const prepareGuestMerge = useCallback(async (previousSession: Session | null) => {
    const guestUserId = previousSession?.user?.id;
    if (!shouldPrepareGuestMerge(previousSession) || !guestUserId) return;

    setMergeState('preparing');
    try {
      const { ticket, expiresAt } = await api.prepareGuestAccountMerge();
      await storeGuestMergeTicket({ guestUserId, ticket, expiresAt: expiresAt ?? null });
      setMergeState('pending');
    } catch (error) {
      const kept = keptGuestMergeTicketFor(await readGuestMergeTickets(), guestUserId, {
        now: Date.now(),
        validForMs: GUEST_MERGE_TICKET_MIN_VALIDITY_MS,
      });
      if (kept) {
        console.warn('Could not mint a fresh guest ticket; signing in on the one kept', error);
        setMergeState('pending');
        return;
      }
      setMergeState('failed');
      console.warn('Could not prepare the guest account link', error);
      // The code, not the wording, is what the sign-in screen maps to its
      // notice: a sentence of its own matched nothing there and was replaced
      // by "Something went wrong on our side" (audit 01-3).
      throw Object.assign(new Error(
        'We could not prepare your guest credits for transfer, so we stopped before '
        + 'switching accounts. Your credits are safe on this device. Check your '
        + 'connection and try again.',
      ), { code: GUEST_MERGE_PREPARE_ERROR_CODE });
    }
  }, [api]);

  // Reads the outcome kept on the device, once. An outcome decided in this run
  // of the app before the read lands stands over it.
  const loadKeptMergeOutcome = useCallback(() => {
    mergeOutcomeLoadRef.current ??= readGuestMergeOutcome().then((stored) => {
      if (keptMergeOutcomeRef.current !== undefined) return;
      keptMergeOutcomeRef.current = stored;
      setKeptMergeOutcome(stored);
    });
    return mergeOutcomeLoadRef.current;
  }, []);

  /**
   * Folds a redemption's outcome into the one kept for the account (credits of
   * two successes add up; one that cannot arrive outranks the rest), and keeps
   * the result until the person dismisses it (audit 02-8).
   */
  const keepGuestMergeOutcome = useCallback(async (accountUserId: string, next: GuestMergeOutcome) => {
    await loadKeptMergeOutcome();
    const current = keptMergeOutcomeRef.current;
    const base = current?.accountUserId === accountUserId ? current : null;
    const combined = combineGuestMergeOutcomes(base, next);
    if (!combined || combined === base) return;
    const kept: KeptGuestMergeOutcome = { ...combined, accountUserId };
    keptMergeOutcomeRef.current = kept;
    setKeptMergeOutcome(kept);
    await storeGuestMergeOutcome(kept);
  }, [loadKeptMergeOutcome]);

  const dismissGuestMergeOutcome = useCallback(() => {
    keptMergeOutcomeRef.current = null;
    setKeptMergeOutcome(null);
    void clearGuestMergeOutcome();
  }, []);

  useEffect(() => {
    // Only an account is ever shown an outcome, so a guest never reads it.
    if (registeredUser) void loadKeptMergeOutcome();
  }, [loadKeptMergeOutcome, registeredUser]);

  const guestMergeOutcome = useMemo<GuestMergeOutcome | null>(() => {
    if (!keptMergeOutcome || keptMergeOutcome.accountUserId !== registeredUser?.id) return null;
    const { status, creditsMoved, at } = keptMergeOutcome;
    return { status, creditsMoved, at };
  }, [keptMergeOutcome, registeredUser]);

  const runGuestMergeRedemption = useCallback(async () => {
    // Read from the session already in hand rather than asking Supabase again.
    // This runs on every launch and every foreground, and auth-provider-
    // performance.test.tsx pins the number of getSession() calls at startup
    // precisely so additions like this cannot quietly add I/O to the cold path.
    const accountUserId = getRegisteredUser(sessionRef.current)?.id;
    if (!accountUserId) return;
    const tickets = ticketsRedeemableFor(await readGuestMergeTickets(), accountUserId);
    if (tickets.length === 0) return;

    setMergeState('merging');
    let waiting = false;
    let lost = false;
    let outcome: GuestMergeOutcome | null = null;
    for (const stored of tickets) {
      // The account left this device mid-run: the rest wait for its next sign-in.
      if (getRegisteredUser(sessionRef.current)?.id !== accountUserId) {
        waiting = true;
        break;
      }
      if (stored.redeemedForUserId === null) {
        try {
          // Recorded before it is sent, since the server may spend it for this
          // account even when the answer never arrives.
          await bindGuestMergeTicket(stored.ticket, accountUserId);
        } catch (error) {
          console.warn('Could not record the account a guest ticket is for; will retry', error);
          waiting = true;
          continue;
        }
      }

      // The decision itself lives in guest-merge.ts so it is testable without
      // rendering: it is what determines whether a bad network costs someone the
      // credits they paid for.
      let action;
      try {
        const result = await api.mergeGuestAccount(stored.ticket);
        action = resolveMergeRedeemAction(result.status);
        outcome = combineGuestMergeOutcomes(outcome, guestMergeOutcomeOf(result, Date.now()));
        // The account's balance once the credits moved, as the server counted it.
        if (typeof result.credits === 'number' && sessionUserIdRef.current === accountUserId) {
          creditsSettledVersionRef.current = authStateVersionRef.current;
          creditsMovedHereRef.current += 1;
          setCredits(result.credits);
          setCreditsUpdatedAt(Date.now());
        }
      } catch (error) {
        console.warn('Could not link guest data yet; will retry', error);
        action = resolveMergeRedeemFailureAction();
      }
      if (action.clearTicket) await removeGuestMergeTicket(stored.ticket);
      if (action.nextState === 'pending') waiting = true;
      if (action.nextState === 'failed') lost = true;
    }

    setMergeState(waiting ? 'pending' : lost ? 'failed' : 'idle');
    if (outcome) await keepGuestMergeOutcome(accountUserId, outcome);
  }, [api, keepGuestMergeOutcome]);

  /**
   * Redeem the kept tickets against the registered session (audit 02-7, 04-8):
   * every ticket already sent for this account, and every one not yet sent for
   * any, each recorded against the account before it goes. A ticket sent for
   * another account is left for that one.
   *
   * Safe to call at any time: it is a no-op without a ticket, and a ticket is
   * only cleared on a settled outcome. Failures are swallowed because the ticket
   * survives them — this runs again at the next launch or foreground, which is
   * what makes a crash between sign-in and redemption survivable. A call made
   * while a run is under way joins it, so the sign-in's own redemption and the
   * launch retry beside it send each ticket once.
   */
  const redeemGuestMerge = useCallback((): Promise<void> => {
    guestMergeRedemptionRef.current ??= runGuestMergeRedemption().finally(() => {
      guestMergeRedemptionRef.current = null;
    });
    return guestMergeRedemptionRef.current;
  }, [runGuestMergeRedemption]);

  useEffect(() => {
    // The retry that makes a ticket worth having. A crash, a dead network, or
    // the user killing the app between sign-in and redemption leaves a stored
    // ticket behind; this picks it up on the next launch and on every return to
    // the foreground, until the server gives a settled answer.
    if (!registeredUser) return;

    void redeemGuestMerge();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void redeemGuestMerge();
    });

    return () => subscription.remove();
  }, [redeemGuestMerge, registeredUser]);

  /**
   * "Set up later" on the account (audit 02-11): the `user_metadata` record the
   * web keeps and reads at every sign-in there, so a creator who chose it on one
   * device is not sent to set up a profile on another. The install keeps its own
   * record beside it (the onboarding state), which this does not touch.
   */
  const markIdentityDeferredOnAccount = useCallback(async () => {
    const account = getRegisteredUser(sessionRef.current);
    if (!isSupabaseConfigured || !account || isIdentityDeferredOnAccount(account)) return;
    try {
      await initializeSupabaseAuth();
      const { error } = await supabase.auth.updateUser({
        data: { [IDENTITY_DEFERRED_METADATA_KEY]: IDENTITY_DEFERRED_METADATA_VERSION },
      });
      if (error) throw error;
    } catch (error) {
      // The choice still holds on this device, which keeps its own record of it.
      console.warn('Could not record "Set up later" on the account', error);
    }
  }, []);

  useEffect(() => {
    guestBootstrapActiveRef.current = true;
    // A retry that was waiting when this effect last stopped (an <Activity>
    // hiding the provider clears its timer) is armed again.
    if (guestBootstrapRetryAtRef.current > 0) void ensureGuestSession({ whenDue: true });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const current = sessionRef.current;
      if (!current) {
        // No identity: the guest bootstrap is tried again now, whatever its
        // backoff says. The network may well have come back with the person.
        void ensureGuestSession();
        return;
      }
      // Purchases settled by a store webhook or on the web, and referral
      // rewards, land while the app is away (audit 03-4).
      if (Date.now() - lastProfileRefreshAtRef.current >= RESUME_PROFILE_REFRESH_INTERVAL_MS) {
        void refreshProfile();
      }
      // A ticket mint that failed for a guest holding credits is tried again.
      const held = creditsRef.current;
      if (isGuestSession(current) && held !== null && held > 0) void ensureGuestMergeTicket();
    });
    return () => {
      guestBootstrapActiveRef.current = false;
      subscription.remove();
      if (guestBootstrapTimerRef.current) clearTimeout(guestBootstrapTimerRef.current);
      guestBootstrapTimerRef.current = null;
    };
  }, [ensureGuestMergeTicket, ensureGuestSession, refreshProfile]);

  const beginFeedIdentityTransition = (previousSession: Session | null) => {
    const userId = previousSession?.user?.id;
    const accessToken = previousSession?.access_token;
    if (!userId || !accessToken) {
      // Installation-scoped events stay universally sendable, including after
      // an anonymous guest session is minted.
      void flushShowcaseFeedEvents();
      return null;
    }

    // The bearer token lives only in memory. The queue performs its immediate
    // drain in the background and applies persisted backoff without placing a
    // 30-second telemetry request on the sign-in/sign-out critical path.
    return beginShowcaseFeedEventIdentityTransition({
      identityKey: `user:${userId}`,
      accessToken,
      accessTokenExpiresAt: typeof previousSession.expires_at === 'number'
        ? previousSession.expires_at * 1_000
        : null,
    });
  };

  /**
   * Remembers the guest a sign-in moved this device from, under the account it
   * went into. What that guest left on the phone (its Create drafts, a saved
   * generation) is the same person's, and goes if the account is deleted.
   */
  const rememberLinkedGuest = (previousSession: Session | null) => {
    const guestUserId = isGuestSession(previousSession) ? previousSession?.user?.id : null;
    const accountUserId = getRegisteredUser(sessionRef.current)?.id;
    if (!guestUserId || !accountUserId) return;
    const linked = linkedGuestUserIdsRef.current.get(accountUserId) ?? new Set<string>();
    linked.add(guestUserId);
    linkedGuestUserIdsRef.current.set(accountUserId, linked);
  };

  const runPasswordSignIn = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }
    // Whatever session a deletion ended before, this sign-in makes a new one,
    // and a refusal of it is acted on (audit 04-2).
    endedDeletionSessionTokenRef.current = null;

    // Prepared before the sign-in replaces the guest session. Throws — and so
    // abandons the sign-in — rather than risk stranding purchased credits.
    const previousSession = sessionRef.current;
    await prepareGuestMerge(previousSession);
    const feedIdentityTransition = beginFeedIdentityTransition(previousSession);

    try {
      await initializeSupabaseAuth();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw normalizeSupabaseAuthError(error, env.supabaseUrl);
    }
    feedIdentityTransition?.commit();
    rememberLinkedGuest(previousSession);

    await redeemGuestMerge();
    await refreshProfile();
  };

  const runAppleSignIn = async (mode: AuthMode) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'ios') {
      throw new Error('Apple sign-in is available on iOS only.');
    }
    endedDeletionSessionTokenRef.current = null;

    const previousSession = sessionRef.current;
    await prepareGuestMerge(previousSession);
    const feedIdentityTransition = beginFeedIdentityTransition(previousSession);

    try {
      await initializeSupabaseAuth();
      await signInWithNativeApple(supabase);
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw normalizeSupabaseAuthError(error, env.supabaseUrl);
    }
    feedIdentityTransition?.commit();
    rememberLinkedGuest(previousSession);

    await redeemGuestMerge();
    await refreshProfile();
  };

  const runGoogleSignIn = async () => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'android') {
      throw new Error('Google sign-in is available on Android only in this app.');
    }
    endedDeletionSessionTokenRef.current = null;

    const previousSession = sessionRef.current;
    await prepareGuestMerge(previousSession);
    const feedIdentityTransition = beginFeedIdentityTransition(previousSession);

    try {
      await initializeSupabaseAuth();
      await signInWithGoogleOAuth(supabase);
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw normalizeSupabaseAuthError(error, env.supabaseUrl);
    }
    feedIdentityTransition?.commit();
    rememberLinkedGuest(previousSession);

    await redeemGuestMerge();
    await refreshProfile();
  };

  /**
   * Runs a sign-in with no guest bootstrap beside it (audit 02-6). One under
   * way finishes first, so the guest it makes is the one this sign-in prepares
   * a ticket for, rather than one that lands after the account and replaces
   * it; and none starts until the sign-in is over. A guest ticket being minted
   * is waited for too, so it is kept before the sign-in's own replaces it,
   * never after the account has been sent the one it has.
   */
  const duringSignIn = async (signIn: () => Promise<void>) => {
    signInsInFlightRef.current += 1;
    try {
      await Promise.all([guestBootstrapRef.current, ...guestTicketMintsRef.current.values()]);
      await signIn();
    } finally {
      signInsInFlightRef.current -= 1;
    }
  };

  const signInWithPassword = (email: string, password: string) => duringSignIn(() => runPasswordSignIn(email, password));
  const signInWithApple = (mode: AuthMode) => duringSignIn(() => runAppleSignIn(mode));
  const signInWithGoogle = () => duringSignIn(runGoogleSignIn);

  const isEndedDeletionSession = (candidate: Session | null) => (
    Boolean(candidate?.access_token) && candidate?.access_token === endedDeletionSessionTokenRef.current
  );

  /**
   * The session as this device holds it now, while it is still `target`'s
   * account: a token refresh while a request was out replaced the token it was
   * captured with.
   */
  const latestSessionOf = (target: Session | null) => {
    const current = sessionRef.current;
    return current && target && current.user?.id === target.user?.id ? current : target;
  };

  /**
   * How a session leaves this device, whichever way it ends: a sign-out, a
   * session the server refused (401), a guest merged into an account (409
   * SESSION_MERGED), a deletion, and a deletion's sign-in that landed on
   * another account. One list, so whatever is added for one way out is cleared
   * by all of them: the creator caches were cleared by the sign-out alone, and
   * after any other way out the next person on a shared phone saw the last
   * one's Following and owner controls (audit 04-6). Where to go next is the
   * caller's.
   */
  const tearDownLocalSession = async ({ reason, endedSession }: {
    reason: LocalSessionEndReason;
    endedSession: Session | null;
  }) => {
    const endedUserId = endedSession?.user?.id ?? null;
    const deleted = reason === 'account-deleted';
    // Set before anything is awaited: every refusal of this session arriving
    // from here on finds it ended already.
    if (deleted) endedDeletionSessionTokenRef.current = endedSession?.access_token ?? null;
    // auth-js's own copy of a refused, spent or unwanted session goes with a
    // local sign-out, and nothing else is asked of the server: each call would
    // be refused like the request that started this. A sign-out has made that
    // call already, and a deleted account's is refused outright.
    if (isSupabaseConfigured && reason !== 'signed-out' && !deleted) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
    // What a deleted account and the guests it was made from left in drafts.
    const draftOwners = deleted && endedUserId
      ? [endedUserId, ...(linkedGuestUserIdsRef.current.get(endedUserId) ?? [])]
      : [];
    await Promise.all([
      clearPersistedSupabaseAuthSession().catch((error) => {
        console.warn('Could not clear the stored session from this device', error);
      }),
      // The home feed, the recent searches and the account numbers saved for
      // the next launch are this person's.
      clearPersistedHomeFeed(),
      clearSearchHistory(),
      clearPersistedAccountState(),
      // A sign-out unregistered from push on the server. No other way out can
      // reach the server, so the registration on the phone goes instead. Guests
      // never register.
      reason !== 'signed-out' && getRegisteredUser(endedSession)
        ? clearLocalMobilePushRegistration().catch((error) => {
          console.warn('Could not clear local push state', error);
        })
        : undefined,
      // The tickets a deleted account could still redeem go with it, so the next
      // account on this phone cannot take those guests' credits; so does what
      // its links came to. On any other way out a ticket is the only copy of a
      // guest's credit secret, and stays.
      deleted ? forgetGuestMergeTicketsFor(endedUserId) : undefined,
      deleted ? clearGuestMergeOutcome() : undefined,
      ...draftOwners.flatMap((userId) => [
        clearCreationDraftsForUser(userId),
        clearComposerDraftsForUser(userId),
        clearGenerationAttemptForUser(userId),
      ]),
    ]);
    if (deleted) {
      // Everything cached belonged to the account.
      queryClient.clear();
    } else {
      // Creator pages are kept without the viewer in their key, and carry
      // whether this person follows or owns them: the next one on this phone
      // would see that for up to a minute (five for the follow buttons).
      queryClient.removeQueries({ predicate: isViewerlessCreatorQuery });
    }
    if (deleted) {
      keptMergeOutcomeRef.current = null;
      setKeptMergeOutcome(null);
    }
    resetAuthState();
    // Every way out drops back to a guest identity rather than to nothing, so
    // browsing and buying keep working.
    void ensureGuestSession();
  };

  const runSignOut = async () => {
    // Drives the app-wide cover in components/sign-out-overlay.tsx.
    setIsSigningOut(true);
    const endedSession = sessionRef.current;
    const feedIdentityTransition = beginFeedIdentityTransition(endedSession);
    try {
      try {
        if (isSupabaseConfigured) {
          // The refresh timer takes the same auth lock as sign-out. Paused, it
          // can neither queue refresh checks behind a slow sign-out nor save
          // the old session back after the local clear below.
          await supabase.auth.stopAutoRefresh();
          await duringSignOut(async () => {
            await unregisterPushBeforeSignOut(api);
            // This device only. Supabase's default is a global sign-out, which also
            // ended the account's session on every other phone, and each of those
            // then had every request refused until its token expired.
            const { error } = await supabase.auth.signOut({ scope: 'local' });
            // The server could not confirm the sign-out: offline, timed out,
            // or failing. Finish on this phone anyway, because the person asked
            // to leave.
            if (error) {
              console.warn('Sign-out was not confirmed by the server; finishing on this device', error);
            }
          });
        }
      } catch (error) {
        // A failure on the phone itself. The session stays, and the side menu
        // tells the person to try again.
        feedIdentityTransition?.cancel();
        throw error;
      }
      feedIdentityTransition?.commit();
      await tearDownLocalSession({ reason: 'signed-out', endedSession });
      router.replace('/auth');
    } finally {
      // After the local clear, so the timer resumes on the guest session, or on
      // the untouched one when sign-out failed on this phone.
      if (isSupabaseConfigured) void supabase.auth.startAutoRefresh();
      setIsSigningOut(false);
    }
  };

  const signOut = () => {
    // A second tap while the first sign-out is still on the network joins it
    // rather than starting another.
    signOutInFlightRef.current ??= runSignOut().finally(() => {
      signOutInFlightRef.current = null;
    });
    return signOutInFlightRef.current;
  };

  /**
   * Recovery for a guest identity that was linked to an account elsewhere.
   *
   * Every authenticated route answers this device 409 SESSION_MERGED, so there
   * is no session state worth preserving and nothing to ask the user first —
   * the app is already unusable. Three things make this different from signOut:
   *
   * - `scope: 'local'`. The token is spent server-side already, and a global
   *   sign-out would reach for sessions that now belong to the registered
   *   account. Local teardown is the same choice the reauthentication-mismatch
   *   path makes.
   * - No push unregister. That call is itself an authenticated route, so it
   *   would 409 and throw before the teardown ran. The server already treats a
   *   merged identity's push rows as stranded.
   * - The stored guest merge ticket is deliberately left alone. It is the only
   *   copy of the secret that moves the old guest's credits onto the account,
   *   and the launch retry redeems it once the person signs in.
   */
  const abandonMergedGuestSession = async () => {
    // A registered session must never be torn down by this path. SESSION_MERGED
    // is only ever issued for an anonymous identity, so anything else reaching
    // here is a bug upstream and is safer ignored than acted on.
    const mergedSession = sessionRef.current;
    if (!isGuestSession(mergedSession)) return;
    beginFeedIdentityTransition(mergedSession)?.commit();
    await tearDownLocalSession({ reason: 'guest-merged', endedSession: mergedSession });
    // Signed in, the person comes back to where they were (audit 01-12).
    router.replace(signInNoticeRoute('session-merged', currentRouteRef.current));
  };

  /**
   * Recovery for a session token the server refused (401), which almost always
   * means the session ended somewhere else: a sign-out on another device from a
   * build that still signed out everywhere, for instance.
   *
   * The device cannot tell on its own. Its access token is self-contained and
   * still carries a future expiry, so it would be sent, and refused, on every
   * request until it ran out: up to an hour of error screens.
   *
   * Supabase is asked directly, and only a definitive answer is acted on. The
   * API answers 401 whenever it cannot verify a token, including while Supabase
   * Auth itself is failing, so the refusal alone proves nothing; tearing down or
   * forcing a refresh on it would sign people out during an outage. See
   * probeSupabaseSession for why the check is not a refresh.
   */
  const recoverRejectedSession = () => {
    if (!isSupabaseConfigured) return Promise.resolve();
    // Every in-flight request is refused at once; one check answers them all.
    if (!rejectedSessionRecoveryRef.current) {
      rejectedSessionRecoveryRef.current = checkRejectedSession().finally(() => {
        rejectedSessionRecoveryRef.current = null;
      });
    }
    return rejectedSessionRecoveryRef.current;
  };

  const checkRejectedSession = async () => {
    const refusedSession = sessionRef.current;
    if (!refusedSession?.access_token) return;

    const verdict = await probeSupabaseSession({
      supabaseUrl: env.supabaseUrl,
      publishableKey: env.supabasePublishableKey,
      accessToken: refusedSession.access_token,
    });
    if (verdict === 'refused') {
      // Supabase answered, and refused this token without saying the session is
      // gone: an expired or unverifiable token. It has just answered cleanly, so
      // a refresh is safe to force, and it settles the question either way.
      await initializeSupabaseAuth();
      const { error } = await supabase.auth.refreshSession();
      if (!isSessionEndedRefreshError(error)) return;
    } else if (verdict !== 'ended') {
      // Alive, or no clean answer: nothing to undo. A device still refused
      // after the api-client's renotify window checks again.
      return;
    }

    // A sign-in that finished while the check was running owns the device now.
    // The refusal was about the identity it replaced.
    const currentSession = sessionRef.current;
    if (currentSession && currentSession.user?.id !== refusedSession.user?.id) return;
    // A deletion revokes every session of the account before it is answered.
    // The deletion ends this device's session itself once its answer is in, and
    // a refusal of the session it ended must not sign out, and move, again.
    if (accountDeletionInFlightRef.current || isEndedDeletionSession(refusedSession)) return;

    const wasGuest = isGuestSession(refusedSession);
    beginFeedIdentityTransition(refusedSession)?.commit();
    // Local only: the push unregister route, like every other, would be
    // refused as the request that started this was.
    await tearDownLocalSession({ reason: 'session-ended', endedSession: refusedSession });
    // A guest had nothing to sign back in to and carries on as a fresh one. A
    // registered person is told why they are suddenly signed out, and comes
    // back to where they were once signed in again (audit 01-12).
    if (!wasGuest) router.replace(signInNoticeRoute('signed-out', currentRouteRef.current));
  };

  /**
   * How every way out of a deleted account ends: the deletion answered on this
   * phone, and a 409 ACCOUNT_DELETING from any request. The server has revoked,
   * or is removing, every session, so nothing here asks it for anything.
   */
  const endDeletedAccountSession = async (endedSession: Session | null) => {
    await tearDownLocalSession({ reason: 'account-deleted', endedSession });
    // One move, to Home: every screen above it belonged to the account.
    router.dismissTo('/');
  };

  /**
   * Every account route answers 409 ACCOUNT_DELETING from the moment a deletion
   * starts, asked for on this phone or on another device, and the server
   * finishes it whatever this device does: the session is over.
   */
  const leaveDeletingAccount = async () => {
    const deletingSession = sessionRef.current;
    // Only a registered account is ever deleted. A deletion asked for on this
    // phone ends the session itself, in its own words, once its answer is in.
    if (
      !getRegisteredUser(deletingSession)
      || accountDeletionInFlightRef.current
      || isEndedDeletionSession(deletingSession)
    ) {
      return false;
    }
    beginFeedIdentityTransition(deletingSession)?.commit();
    await endDeletedAccountSession(deletingSession);
    return true;
  };

  const runAccountDeletion = async (
    reauthentication?: AccountDeletionReauthentication,
  ): Promise<AccountDeletionOutcome> => {
    if (!registeredUser) {
      throw new Error('Sign in before deleting your account.');
    }
    // Captured before reauthentication can replace the Supabase session
    // (including the mismatch path below).
    const accountSession = sessionRef.current;
    const feedIdentityTransition = beginFeedIdentityTransition(accountSession);

    let appleAuthorizationCode: string | undefined;
    if (reauthentication) {
      try {
        // Apple account deletion is verified server-side by exchanging the
        // one-time authorization code with Apple. It does not need another
        // client-to-Supabase sign-in, which can fail on an otherwise healthy
        // device connection and strand the user on this destructive flow.
        if (reauthentication.method !== 'apple') {
          await initializeSupabaseAuth();
        }
        const result = await reauthenticateAccountForDeletion({
          currentUser: registeredUser,
          method: reauthentication,
          supabase,
        });
        appleAuthorizationCode = result.appleAuthorizationCode;
        if (result.session) {
          applySessionState(result.session);
        }
      } catch (error) {
        if (error instanceof AccountReauthenticationAccountMismatchError) {
          // The sign-in landed on another account. Neither session stays: the
          // device drops back to a guest like every other way out, and the
          // person signs in to the account they meant (audit 04-6).
          feedIdentityTransition?.commit();
          await tearDownLocalSession({ reason: 'reauthentication-mismatch', endedSession: accountSession });
          router.replace('/auth');
          throw error;
        }
        feedIdentityTransition?.cancel();
        throw new AccountReauthenticationFailedError(
          reauthentication.method,
          normalizeSupabaseAuthError(error, env.supabaseUrl),
        );
      }
    }

    // The session the request carries. An answer that cannot say whether the
    // deletion started is settled by asking Supabase about it, never by waiting
    // for its token here: the request's own deadline covers that wait.
    const deletingSession = sessionRef.current ?? accountSession;
    let outcome: AccountDeletionOutcome;
    try {
      const result = await api.deleteAccount('DELETE', appleAuthorizationCode ? { appleAuthorizationCode } : {});
      outcome = result.deleted ? 'deleted' : 'scheduled';
    } catch (error) {
      // "Not deleted" is said only when it is true: a deletion the server has
      // started is finished by it, and a retry would be refused.
      const started = isAccountDeletionUnderway(error)
        || (isAmbiguousAccountDeletionAnswer(error)
          ? await deletionStartedOnServer(latestSessionOf(deletingSession)?.access_token ?? null)
          : false);
      if (started === false) {
        feedIdentityTransition?.cancel();
        throw error;
      }
      if (started === null) {
        // Supabase could not say either way. The session stays: a retry, or
        // the next request, settles it (409 or 401 once the deletion runs).
        feedIdentityTransition?.cancel();
        return 'unconfirmed';
      }
      outcome = 'scheduled';
    }
    feedIdentityTransition?.commit();
    await endDeletedAccountSession(latestSessionOf(deletingSession));
    return outcome;
  };

  const deleteAccount = (reauthentication?: AccountDeletionReauthentication) => {
    accountDeletionInFlightRef.current = true;
    return runAccountDeletion(reauthentication).finally(() => {
      accountDeletionInFlightRef.current = false;
    });
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: registeredUser,
        isGuest,
        identityUserId,
        mergeState,
        guestMergeOutcome,
        dismissGuestMergeOutcome,
        ensureGuestMergeTicket,
        markIdentityDeferredOnAccount,
        credits,
        creditsUpdatedAt,
        isLoading,
        isAuthConfigured: isSupabaseConfigured,
        missingEnvKeys,
        api,
        signInWithPassword,
        signInWithApple,
        signInWithGoogle,
        signOut,
        isSigningOut,
        abandonMergedGuestSession,
        recoverRejectedSession,
        leaveDeletingAccount,
        accountReauthenticationMethods,
        deleteAccount,
        refreshProfile,
        updateCredits,
      }}
    >
      <CurrentRouteTracker routeRef={currentRouteRef} />
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Publishes the route on screen into `routeRef`. A component of its own, so a
 * navigation re-renders only it and not every screen that reads the auth
 * context.
 */
function CurrentRouteTracker({ routeRef }: { routeRef: { current: string | null } }) {
  const pathname = usePathname();
  useEffect(() => {
    routeRef.current = pathname;
  }, [pathname, routeRef]);
  return null;
}

async function recoverInvalidAuthSession(error: unknown) {
  if (!isInvalidRefreshTokenError(error)) {
    return false;
  }

  await clearPersistedSupabaseAuthSession();
  await clearPersistedHomeFeed();
  await clearSearchHistory();
  await clearPersistedAccountState();
  return true;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}

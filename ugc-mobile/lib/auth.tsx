import type { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { env, getMissingMobileEnvKeys } from './env';
import {
  resolveMergeRedeemAction,
  resolveMergeRedeemFailureAction,
  shouldPrepareGuestMerge,
  shouldRedeemGuestMerge,
  type GuestMergeState,
} from './guest-merge';
import {
  clearGuestMergeTicket,
  readGuestMergeTicket,
  storeGuestMergeTicket,
} from './guest-merge-ticket-storage';
import { getRegisteredUser, isGuestSession } from './guest-session';
import type { GuestAccountMergeStatus } from './types';
import { signInWithNativeApple } from './apple-auth';
import { signInWithGoogleOAuth } from './google-auth';
import {
  AccountReauthenticationAccountMismatchError,
  getAccountReauthenticationMethods,
  reauthenticateAccountForDeletion,
  type AccountDeletionReauthentication,
  type AccountReauthenticationMethod,
} from './account-reauthentication';
import { ApiError, createApiClient, type MagicbookletApiClient } from './api-client';
import { getFeedInstallationId } from './feed-installation-id';
import {
  beginShowcaseFeedEventIdentityTransition,
  configureFeedEventQueue,
  flushShowcaseFeedEvents,
  restoreShowcaseFeedEvents,
} from './feed-event-queue';
import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION } from './generation-model-catalog';
import { claimPendingReferral } from './referral-attribution';
import {
  clearLocalMobilePushRegistration,
  registerForMobilePushNotifications,
  subscribeToMobilePushTokenChanges,
  unregisterMobilePushNotifications,
} from './notifications';
import {
  clearPersistedSupabaseAuthSession,
  initializeSupabaseAuth,
  isSupabaseConfigured,
  supabase,
} from './supabase';
import {
  isInvalidRefreshTokenError,
  isNetworkRequestFailedError,
  supabaseNetworkFailureMessage,
} from './supabase-auth-recovery';

export type AuthMode = 'login' | 'signup';
export type {
  AccountDeletionReauthentication,
  AccountReauthenticationMethod,
} from './account-reauthentication';
export { getAccountReauthenticationMethods } from './account-reauthentication';

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
  /** Set only for a settled outcome the user must be told about. */
  mergeOutcome: GuestAccountMergeStatus | null;
  /** Dismisses the recovery banner without touching the stored ticket. */
  acknowledgeMergeOutcome: () => void;
  credits: number | null;
  isLoading: boolean;
  isAuthConfigured: boolean;
  missingEnvKeys: string[];
  api: MagicbookletApiClient;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInWithApple: (mode: AuthMode) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  accountReauthenticationMethods: AccountReauthenticationMethod[];
  deleteAccount: (reauthentication?: AccountDeletionReauthentication) => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateCredits: (credits: number | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_ACCESS_TOKEN_MIN_TTL_MS = 30 * 1000;

export { getRegisteredUser, isGuestSession } from './guest-session';

export function isAccountReauthenticationRequired(error: unknown) {
  return error instanceof ApiError
    && (error.code === 'RECENT_AUTH_REQUIRED' || error.code === 'APPLE_REAUTH_REQUIRED');
}

function getUsableCachedAccessToken(session: Session | null, now = Date.now()): string | null {
  if (!session?.access_token) return null;
  if (typeof session.expires_at !== 'number') return session.access_token;
  return session.expires_at * 1000 - now > CACHED_ACCESS_TOKEN_MIN_TTL_MS
    ? session.access_token
    : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  const missingEnvKeys = useMemo(() => getMissingMobileEnvKeys(), []);
  const sessionUserIdRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const guestBootstrapRef = useRef(false);
  const [mergeState, setMergeState] = useState<GuestMergeState>('idle');
  const [mergeOutcome, setMergeOutcome] = useState<GuestAccountMergeStatus | null>(null);
  const authStateVersionRef = useRef(0);
  const profileRefreshRef = useRef<{ promise: Promise<void>; userId: string; version: number } | null>(null);

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
    if (userChanged || !nextUserId) setCredits(null);
    // Navigation can continue from the persisted local session. Profile and
    // credit data refresh independently in the background.
    setIsLoading(false);
  }, []);

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
   */
  const ensureGuestSession = useCallback(async () => {
    if (!isSupabaseConfigured || guestBootstrapRef.current) return;
    guestBootstrapRef.current = true;

    try {
      await initializeSupabaseAuth();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session) return;

      // Drain events recorded while fully signed out before replacing the
      // installation identity with a Supabase guest. Installation-scoped
      // entries remain sendable after the transition if this best-effort flush
      // has to back off.
      void flushShowcaseFeedEvents();
      const { data: guest, error: guestError } = await supabase.auth.signInAnonymously();
      if (guestError) throw guestError;
      if (guest.session) applySessionState(guest.session);
    } catch (error) {
      console.warn('Could not start a guest session; continuing signed out', error);
      guestBootstrapRef.current = false;
    }
  }, [applySessionState]);

  const getAccessToken = useCallback(async () => {
    if (!isSupabaseConfigured) {
      return null;
    }

    const cachedAccessToken = getUsableCachedAccessToken(sessionRef.current);
    if (cachedAccessToken) {
      return cachedAccessToken;
    }

    try {
      await initializeSupabaseAuth();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        if (await recoverInvalidAuthSession(error)) {
          return null;
        }
        throw error;
      }
      sessionRef.current = data.session ?? null;
      return data.session?.access_token ?? null;
    } catch (error) {
      if (await recoverInvalidAuthSession(error)) {
        return null;
      }
      throw error;
    }
  }, []);

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
        if (sessionUserIdRef.current === userId && authStateVersionRef.current === version) {
          setCredits(profile.credits ?? null);
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

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      applySessionState(nextSession ?? null);
      if (nextSession?.user) {
        void refreshProfileForUser(nextSession.user.id).catch((error) => {
          console.warn('Failed to refresh auth state', error);
        });
      }
    });

    let active = true;
    void (async () => {
      try {
        await initializeSupabaseAuth();
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (!active) return;
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
          resetAuthState();
          return;
        }
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
      queryKey: ['mobile-push-registration', userId],
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

  const acknowledgeMergeOutcome = useCallback(() => setMergeOutcome(null), []);

  useEffect(() => {
    // A referral reward is for signing up. Claiming it against a guest row
    // would burn the invite on an identity that has not registered yet.
    if (!registeredUser) return;

    void claimPendingReferral(api).catch((error) => {
      console.warn('Failed to claim pending referral after authentication', error);
    });
  }, [api, registeredUser]);

  /**
   * Mint and store the ticket that will carry this guest's credits across.
   *
   * Runs *before* authentication, while the guest session is still the caller.
   * Throws on failure, and the sign-in is abandoned as a result: continuing
   * would replace the only session that can prove ownership of the guest's
   * balance, with nothing held back to reclaim it. Losing purchased credits
   * silently is far worse than a sign-in the user can retry.
   */
  const prepareGuestMerge = useCallback(async (previousSession: Session | null) => {
    if (!shouldPrepareGuestMerge(previousSession)) return;

    setMergeState('preparing');
    try {
      const { ticket } = await api.prepareGuestAccountMerge();
      await storeGuestMergeTicket(ticket);
      setMergeState('pending');
    } catch (error) {
      setMergeState('failed');
      console.warn('Could not prepare the guest account link', error);
      throw new Error(
        'We could not prepare your guest credits for transfer, so we stopped before '
        + 'switching accounts. Your credits are safe on this device. Check your '
        + 'connection and try again.',
      );
    }
  }, [api]);

  /**
   * Redeem the stored ticket against the registered session.
   *
   * Safe to call at any time: it is a no-op without a ticket, and the ticket is
   * only cleared on a settled outcome. Failures are swallowed because the ticket
   * survives them — this runs again at the next launch or foreground, which is
   * what makes a crash between sign-in and redemption survivable.
   */
  const redeemGuestMerge = useCallback(async () => {
    // Read from the session already in hand rather than asking Supabase again.
    // This runs on every launch and every foreground, and auth-provider-
    // performance.test.tsx pins the number of getSession() calls at startup
    // precisely so additions like this cannot quietly add I/O to the cold path.
    const ticket = await readGuestMergeTicket();
    if (!shouldRedeemGuestMerge(ticket, sessionRef.current)) return;

    setMergeState('merging');

    // The decision itself lives in guest-merge.ts so it is testable without
    // rendering: it is what determines whether a bad network costs someone the
    // credits they paid for.
    let action;
    try {
      const result = await api.mergeGuestAccount(ticket as string);
      action = resolveMergeRedeemAction(result.status);
    } catch (error) {
      console.warn('Could not link guest data yet; will retry', error);
      action = resolveMergeRedeemFailureAction();
    }

    if (action.clearTicket) await clearGuestMergeTicket();
    setMergeState(action.nextState);
    setMergeOutcome(action.outcome);
  }, [api]);

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

  const signInWithPassword = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

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
      throw normalizeSupabaseAuthError(error);
    }
    feedIdentityTransition?.commit();

    await redeemGuestMerge();
    await refreshProfile();
  };

  const signInWithApple = async (mode: AuthMode) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'ios') {
      throw new Error('Apple sign-in is available on iOS only.');
    }

    const previousSession = sessionRef.current;
    await prepareGuestMerge(previousSession);
    const feedIdentityTransition = beginFeedIdentityTransition(previousSession);

    try {
      await initializeSupabaseAuth();
      await signInWithNativeApple(supabase);
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw normalizeSupabaseAuthError(error);
    }
    feedIdentityTransition?.commit();

    await redeemGuestMerge();
    await refreshProfile();
  };

  const signInWithGoogle = async () => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'android') {
      throw new Error('Google sign-in is available on Android only in this app.');
    }

    const previousSession = sessionRef.current;
    await prepareGuestMerge(previousSession);
    const feedIdentityTransition = beginFeedIdentityTransition(previousSession);

    try {
      await initializeSupabaseAuth();
      await signInWithGoogleOAuth(supabase);
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw normalizeSupabaseAuthError(error);
    }
    feedIdentityTransition?.commit();

    await redeemGuestMerge();
    await refreshProfile();
  };

  const signOut = async () => {
    const feedIdentityTransition = beginFeedIdentityTransition(sessionRef.current);
    try {
      if (isSupabaseConfigured) {
        await unregisterMobilePushNotifications(api);
        await supabase.auth.signOut();
      }
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw error;
    }
    feedIdentityTransition?.commit();
    if (isSupabaseConfigured) await clearPersistedSupabaseAuthSession();
    resetAuthState();
    // Signing out drops back to a guest identity rather than to nothing, so
    // browsing and buying keep working. The bootstrap latch is cleared because
    // the previous guest session is gone with the sign-out.
    guestBootstrapRef.current = false;
    void ensureGuestSession();
    router.replace('/auth');
  };

  const deleteAccount = async (reauthentication?: AccountDeletionReauthentication) => {
    if (!registeredUser) {
      throw new Error('Sign in before deleting your account.');
    }
    // Capture the original account before reauthentication can replace the
    // Supabase session (including the mismatch path below).
    const feedIdentityTransition = beginFeedIdentityTransition(sessionRef.current);

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
          await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
          feedIdentityTransition?.commit();
          await clearPersistedSupabaseAuthSession();
          resetAuthState();
          router.replace('/auth');
        } else {
          feedIdentityTransition?.cancel();
        }
        throw normalizeSupabaseAuthError(error);
      }
    }

    try {
      await api.deleteAccount('DELETE', appleAuthorizationCode ? { appleAuthorizationCode } : {});
    } catch (error) {
      feedIdentityTransition?.cancel();
      throw error;
    }
    feedIdentityTransition?.commit();
    await Promise.all([
      clearLocalMobilePushRegistration().catch((error) => {
        console.warn('Could not clear local push state after account deletion', error);
      }),
      clearPersistedSupabaseAuthSession().catch((error) => {
        console.warn('Could not clear the local auth session after account deletion', error);
      }),
      clearGuestMergeTicket().catch((error) => {
        console.warn('Could not clear the guest merge ticket after account deletion', error);
      }),
    ]);
    queryClient.clear();
    resetAuthState();
    router.replace('/auth');
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: registeredUser,
        isGuest,
        identityUserId,
        mergeState,
        mergeOutcome,
        acknowledgeMergeOutcome,
        credits,
        isLoading,
        isAuthConfigured: isSupabaseConfigured,
        missingEnvKeys,
        api,
        signInWithPassword,
        signInWithApple,
        signInWithGoogle,
        signOut,
        accountReauthenticationMethods,
        deleteAccount,
        refreshProfile,
        updateCredits: setCredits,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

async function recoverInvalidAuthSession(error: unknown) {
  if (!isInvalidRefreshTokenError(error)) {
    return false;
  }

  await clearPersistedSupabaseAuthSession();
  return true;
}

function normalizeSupabaseAuthError(error: unknown) {
  if (isNetworkRequestFailedError(error)) {
    return new Error(supabaseNetworkFailureMessage(env.supabaseUrl));
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error('Authentication failed.');
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}

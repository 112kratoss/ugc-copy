import type { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { env, getMissingMobileEnvKeys } from './env';
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
import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION } from './generation-model-catalog';
import { claimPendingReferral } from './referral-attribution';
import {
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
  user: User | null;
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
  const accountReauthenticationMethods = useMemo(
    () => getAccountReauthenticationMethods(session?.user ?? null),
    [session?.user],
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
  }, [applySessionState, refreshProfileForUser, resetAuthState]);

  useEffect(() => {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      return;
    }

    if (!session?.user?.id) {
      return;
    }

    const userId = session.user.id;
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
  }, [api, queryClient, session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) return;

    void claimPendingReferral(api).catch((error) => {
      console.warn('Failed to claim pending referral after authentication', error);
    });
  }, [api, session?.user?.id]);

  const signInWithPassword = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    try {
      await initializeSupabaseAuth();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (error) {
      throw normalizeSupabaseAuthError(error);
    }

    await refreshProfile();
  };

  const signInWithApple = async (mode: AuthMode) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'ios') {
      throw new Error('Apple sign-in is available on iOS only.');
    }

    try {
      await initializeSupabaseAuth();
      await signInWithNativeApple(supabase);
    } catch (error) {
      throw normalizeSupabaseAuthError(error);
    }

    await refreshProfile();
  };

  const signInWithGoogle = async () => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    if (Platform.OS !== 'android') {
      throw new Error('Google sign-in is available on Android only in this app.');
    }

    try {
      await initializeSupabaseAuth();
      await signInWithGoogleOAuth(supabase);
    } catch (error) {
      throw normalizeSupabaseAuthError(error);
    }

    await refreshProfile();
  };

  const signOut = async () => {
    if (isSupabaseConfigured) {
      await unregisterMobilePushNotifications(api);
      await supabase.auth.signOut();
      await clearPersistedSupabaseAuthSession();
    }
    resetAuthState();
    router.replace('/auth');
  };

  const deleteAccount = async (reauthentication?: AccountDeletionReauthentication) => {
    if (!session?.user) {
      throw new Error('Sign in before deleting your account.');
    }

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
          currentUser: session.user,
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
          await clearPersistedSupabaseAuthSession();
          resetAuthState();
          router.replace('/auth');
        }
        throw normalizeSupabaseAuthError(error);
      }
    }

    await unregisterMobilePushNotifications(api).catch((error) => {
      console.warn('Could not unregister push notifications before account deletion', error);
    });
    await api.deleteAccount('DELETE', appleAuthorizationCode ? { appleAuthorizationCode } : {});
    await clearPersistedSupabaseAuthSession();
    resetAuthState();
    router.replace('/auth');
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
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

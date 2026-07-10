import type { Session, User } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { env, getMissingMobileEnvKeys } from './env';
import { signInWithNativeApple } from './apple-auth';
import { createApiClient, type MagicbookletApiClient } from './api-client';
import { GENERATION_MODEL_CATALOG_SCHEMA_VERSION } from './generation-model-catalog';
import { getProfileCreditsOrNull } from './auth-profile';
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

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  credits: number | null;
  isLoading: boolean;
  isAuthConfigured: boolean;
  missingEnvKeys: string[];
  api: MagicbookletApiClient;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUpWithPassword: (email: string, password: string) => Promise<void>;
  signInWithApple: (mode: AuthMode) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateCredits: (credits: number | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const missingEnvKeys = useMemo(() => getMissingMobileEnvKeys(), []);

  const resetAuthState = useCallback(() => {
    setSession(null);
    setCredits(null);
    setIsLoading(false);
  }, []);

  const getAccessToken = useCallback(async () => {
    if (!isSupabaseConfigured) {
      return null;
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
      clientInfo: {
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        apiVersion: 1,
        catalogSchemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
      },
    }),
    [getAccessToken]
  );

  const refreshProfile = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setSession(null);
      setCredits(null);
      setIsLoading(false);
      return;
    }

    let latestSession: Session | null = null;

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
      latestSession = data.session ?? null;
    } catch (error) {
      if (await recoverInvalidAuthSession(error)) {
        resetAuthState();
        return;
      }
      console.warn('Failed to recover mobile auth session', error);
      resetAuthState();
      return;
    }

    setSession(latestSession ?? null);

    if (!latestSession?.user) {
      resetAuthState();
      return;
    }

    const nextCredits = await getProfileCreditsOrNull(api);
    setCredits(nextCredits);
    setIsLoading(false);
  }, [api, resetAuthState]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }

    void refreshProfile();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
      if (nextSession?.user) {
        void refreshProfile().catch((error) => {
          console.warn('Failed to refresh auth state', error);
          setIsLoading(false);
        });
      } else {
        setCredits(null);
        setIsLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [refreshProfile]);

  useEffect(() => {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
      return;
    }

    if (!session?.user?.id) {
      return;
    }

    const syncPushRegistration = () => registerForMobilePushNotifications(api, { requestPermission: false }).catch((error) => {
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
    router.replace('/(tabs)');
  };

  const signUpWithPassword = async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      throw new Error(`Configure mobile auth first: ${missingEnvKeys.join(', ')}`);
    }

    try {
      await initializeSupabaseAuth();
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
    } catch (error) {
      throw normalizeSupabaseAuthError(error);
    }

    await refreshProfile();
    router.replace('/(tabs)/profile');
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
    router.replace(mode === 'signup' ? '/(tabs)/profile' : '/(tabs)');
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
        signUpWithPassword,
        signInWithApple,
        signOut,
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

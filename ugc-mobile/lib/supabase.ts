import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import { env, isMobileEnvConfigured } from './env';
import { withSuppressedInvalidRefreshTokenConsoleError } from './supabase-auth-recovery';

export const isSupabaseConfigured = isMobileEnvConfigured();
export const supabaseAuthStorageKey = getSupabaseAuthStorageKey();

const serverAuthStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
};

export const supabase = createClient(
  isSupabaseConfigured ? env.supabaseUrl : 'https://missing-mobile-env.supabase.co',
  isSupabaseConfigured ? env.supabasePublishableKey : 'missing-mobile-env',
  {
    auth: {
      storage: typeof window === 'undefined' ? serverAuthStorage : AsyncStorage,
      storageKey: supabaseAuthStorageKey,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      skipAutoInitialize: true,
    },
  },
);

let supabaseAuthInitializePromise: Promise<void> | null = null;

export function initializeSupabaseAuth() {
  if (!isSupabaseConfigured) {
    return Promise.resolve();
  }

  if (!supabaseAuthInitializePromise) {
    supabaseAuthInitializePromise = withSuppressedInvalidRefreshTokenConsoleError(async () => {
      await supabase.auth.initialize();
    }).catch((error) => {
      supabaseAuthInitializePromise = null;
      throw error;
    });
  }

  return supabaseAuthInitializePromise;
}

export async function clearPersistedSupabaseAuthSession() {
  if (!isSupabaseConfigured || typeof window === 'undefined') {
    return;
  }

  await AsyncStorage.multiRemove([
    supabaseAuthStorageKey,
    `${supabaseAuthStorageKey}-code-verifier`,
    `${supabaseAuthStorageKey}-user`,
  ]);
}

function getSupabaseAuthStorageKey() {
  if (!isSupabaseConfigured) {
    return 'sb-missing-mobile-env-auth-token';
  }

  try {
    const hostname = new URL(env.supabaseUrl).hostname;
    return `sb-${hostname.split('.')[0]}-auth-token`;
  } catch {
    return 'sb-mobile-auth-token';
  }
}

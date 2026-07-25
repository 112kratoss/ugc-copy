import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';

import { env, isMobileEnvConfigured } from './env';
import { secureSessionStorage } from './secure-session-storage';
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
      // Session (refresh token) persistence goes through SecureStore-backed
      // storage with transparent AsyncStorage migration and fallback.
      storage: typeof window === 'undefined' ? serverAuthStorage : secureSessionStorage,
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

  // removeItem clears both the SecureStore chunks and any legacy plaintext
  // AsyncStorage copy for each key.
  await Promise.all([
    supabaseAuthStorageKey,
    `${supabaseAuthStorageKey}-code-verifier`,
    `${supabaseAuthStorageKey}-user`,
  ].map((key) => secureSessionStorage.removeItem(key)));
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

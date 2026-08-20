import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { env, isMobileEnvConfigured } from './env';
import {
  configureSecureSessionInvalidationHandler,
  createMemorySessionStorage,
  secureSessionStorage,
} from './secure-session-storage';
import { withSuppressedInvalidRefreshTokenConsoleError } from './supabase-auth-recovery';

export const isSupabaseConfigured = isMobileEnvConfigured();
export const supabaseAuthStorageKey = getSupabaseAuthStorageKey();

const serverAuthStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
};

// Expo web sessions intentionally survive only for the lifetime of this JS
// runtime. A page refresh requires reauthentication and no refresh token is
// written to localStorage, IndexedDB, or another browser-persistent store.
export const webMemoryAuthStorage = createMemorySessionStorage();

export const supabaseAuthStorage = Platform.OS === 'web'
  ? typeof window === 'undefined'
    ? serverAuthStorage
    : webMemoryAuthStorage
  : secureSessionStorage;

export const supabase = createClient(
  isSupabaseConfigured ? env.supabaseUrl : 'https://missing-mobile-env.supabase.co',
  isSupabaseConfigured ? env.supabasePublishableKey : 'missing-mobile-env',
  {
    auth: {
      // Native refresh tokens are SecureStore-only. Expo web uses the
      // process-local adapter above and never browser-persistent storage.
      storage: supabaseAuthStorage,
      storageKey: supabaseAuthStorageKey,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      skipAutoInitialize: true,
    },
  },
);

let secureStorageSignOutPromise: Promise<void> | null = null;

if (Platform.OS !== 'web') {
  configureSecureSessionInvalidationHandler((reason) => {
    if (secureStorageSignOutPromise) return;
    // Defer until the storage operation that detected the failure releases its
    // per-key queue. Supabase's local sign-out then clears its in-memory
    // session and emits SIGNED_OUT without creating a storage deadlock.
    secureStorageSignOutPromise = Promise.resolve()
      .then(async () => {
        const { error } = await supabase.auth.signOut({ scope: 'local' });
        if (error) {
          console.warn(`Could not complete local sign-out after ${reason}.`, error);
        }
      })
      .catch((error) => {
        console.warn(`Could not complete local sign-out after ${reason}.`, error);
      })
      .finally(() => {
        secureStorageSignOutPromise = null;
      });
  });
}

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
  if (!isSupabaseConfigured || (Platform.OS === 'web' && typeof window === 'undefined')) {
    return;
  }

  // Native removeItem clears SecureStore chunks plus legacy plaintext copies;
  // web removes the corresponding process-local entries.
  await Promise.all([
    supabaseAuthStorageKey,
    `${supabaseAuthStorageKey}-code-verifier`,
    `${supabaseAuthStorageKey}-user`,
  ].map((key) => supabaseAuthStorage.removeItem(key)));
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

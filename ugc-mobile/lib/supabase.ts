// No URL polyfill: Expo's runtime installs a spec-compliant URL and
// URLSearchParams on native (expo/src/winter), which auth-js uses as is.
import { AuthClient, type GoTrueClient, type Session } from '@supabase/auth-js';
import { Platform } from 'react-native';

import { env, isMobileEnvConfigured } from './env';
import {
  configureSecureSessionInvalidationHandler,
  createMemorySessionStorage,
  secureSessionStorage,
} from './secure-session-storage';
import {
  parsePersistedSupabaseSession,
  withSuppressedInvalidRefreshTokenConsoleError,
} from './supabase-auth-recovery';
import { createSupabaseAuthFetch } from './supabase-fetch';

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

const supabaseAuthFetch = createSupabaseAuthFetch();

/**
 * Runs sign-out network work with deadlines on the auth requests it can be
 * held up by, so a stalled network cannot keep the person signed in, or the
 * auth lock taken, indefinitely. See lib/supabase-fetch.ts.
 */
export const duringSignOut = supabaseAuthFetch.duringSignOut;

/**
 * The version of the installed `@supabase/auth-js`, named in the
 * `X-Client-Info` header so Supabase's logs tell this client's requests apart.
 * `__tests__/supabase-auth-client.test.ts` holds it to the installed package.
 */
export const AUTH_JS_VERSION = '2.105.4';

const supabaseUrl = (isSupabaseConfigured ? env.supabaseUrl : 'https://missing-mobile-env.supabase.co').trim();
const supabaseKey = isSupabaseConfigured ? env.supabasePublishableKey : 'missing-mobile-env';

/**
 * Supabase Auth's client alone. The app asks Supabase for nothing but auth (the
 * session, its refresh, sign-in and sign-out); every read and write of data goes
 * through the API. supabase-js's `createClient` also builds Realtime, PostgREST
 * and Storage clients, about 143 KB of minified code evaluated at launch, and
 * listens for auth events on Realtime's behalf, which reads the stored session
 * once more on every launch. This is the auth client `createClient` makes, set
 * up as `createClient` sets it up: the same `/auth/v1` URL, the publishable key
 * as `apikey` and bearer, the fetch below unwrapped, and the same auth options.
 * `__tests__/supabase-auth-client.test.ts` holds it to `createClient`'s, request
 * by request, for every auth call the app makes.
 */
export const supabase: { readonly auth: GoTrueClient } = {
  auth: new AuthClient({
    url: new URL('auth/v1', supabaseUrl.endsWith('/') ? supabaseUrl : `${supabaseUrl}/`).href,
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      apikey: supabaseKey,
      'X-Client-Info': `auth-js-react-native/${AUTH_JS_VERSION}`,
    },
    fetch: supabaseAuthFetch.fetch,
    // Native refresh tokens are SecureStore-only. Expo web uses the
    // process-local adapter above and never browser-persistent storage.
    storage: supabaseAuthStorage,
    storageKey: supabaseAuthStorageKey,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
    skipAutoInitialize: true,
  }),
};

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

/**
 * The session this device last stored, read without going through auth-js.
 * auth-js hands a session back only after refreshing an expired access token,
 * and holds its lock while it does; this read waits on neither. It goes through
 * the same secure storage auth-js reads, so a damaged value is erased and signed
 * out exactly as it would be there.
 */
export async function readPersistedSupabaseSession(): Promise<Session | null> {
  if (!isSupabaseConfigured) return null;
  return parsePersistedSupabaseSession(await supabaseAuthStorage.getItem(supabaseAuthStorageKey));
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

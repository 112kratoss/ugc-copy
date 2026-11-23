import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const secureStorage = {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  };
  const memoryStorage = {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  };
  return {
    platform: 'android',
    secureStorage,
    memoryStorage,
    // Stands in for lib/supabase-fetch.ts: the fetch that puts deadlines on
    // auth requests during a sign-out, and the wrapper that switches them on.
    authFetch: { fetch: vi.fn(), duringSignOut: vi.fn() },
    authOptions: null as null | { storage: unknown; fetch?: unknown },
    invalidationHandler: null as null | ((reason: string) => void),
    signOut: vi.fn(async () => ({ error: null })),
  };
});

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
}));

vi.mock('../lib/env', () => ({
  env: {
    supabaseUrl: 'https://project.supabase.co',
    supabasePublishableKey: 'publishable-key',
  },
  isMobileEnvConfigured: () => true,
}));

vi.mock('../lib/secure-session-storage', () => ({
  configureSecureSessionInvalidationHandler: (handler: (reason: string) => void) => {
    state.invalidationHandler = handler;
  },
  createMemorySessionStorage: () => state.memoryStorage,
  secureSessionStorage: state.secureStorage,
}));

vi.mock('../lib/supabase-auth-recovery', () => ({
  parsePersistedSupabaseSession: () => null,
  withSuppressedInvalidRefreshTokenConsoleError: async (operation: () => Promise<void>) => operation(),
}));

vi.mock('../lib/supabase-fetch', () => ({
  createSupabaseAuthFetch: () => state.authFetch,
}));

vi.mock('@supabase/auth-js', () => ({
  AuthClient: class {
    initialize = vi.fn(async () => undefined);
    signOut = state.signOut;

    constructor(options: { storage: unknown; fetch?: unknown }) {
      state.authOptions = options;
    }
  },
}));

describe('Supabase auth storage policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.authOptions = null;
    state.invalidationHandler = null;
    state.platform = 'android';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends auth requests through the deadline fetch, and exports its sign-out wrapper', async () => {
    // Without that fetch, a logout or refresh stalled on the network has no
    // deadline during a sign-out and holds auth-js's lock, and the person is
    // left on "Signing out…" (lib/supabase-fetch.ts).
    const { duringSignOut } = await import('../lib/supabase');

    expect(state.authOptions?.fetch).toBe(state.authFetch.fetch);
    expect(duringSignOut).toBe(state.authFetch.duringSignOut);
  });

  it('uses SecureStore on native even when there is no window global', async () => {
    await import('../lib/supabase');

    expect(state.authOptions?.storage).toBe(state.secureStorage);
    expect(state.invalidationHandler).toBeTypeOf('function');

    state.invalidationHandler?.('secure-store-unavailable');
    await vi.waitFor(() => {
      expect(state.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });
  });

  it('uses process memory on the Expo web client and clears that same adapter', async () => {
    state.platform = 'web';
    vi.stubGlobal('window', {});

    const { clearPersistedSupabaseAuthSession } = await import('../lib/supabase');

    expect(state.authOptions?.storage).toBe(state.memoryStorage);
    expect(state.invalidationHandler).toBeNull();

    await clearPersistedSupabaseAuthSession();
    expect(state.memoryStorage.removeItem).toHaveBeenCalledTimes(3);
    expect(state.memoryStorage.removeItem).toHaveBeenCalledWith('sb-project-auth-token');
  });
});

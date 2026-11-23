import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';
import type { GoTrueClient } from '@supabase/auth-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupabaseAuthFetch } from '../lib/supabase-fetch';

/**
 * The app builds Supabase Auth's client alone (`lib/supabase.ts`) where it used
 * to build all of supabase-js with `createClient`. Here the client supabase-js
 * would have made from the app's old options stands beside the app's, and the
 * two are held to the same settings and, for every auth call the app makes, the
 * same request on the wire.
 */

const SUPABASE_URL = 'https://project-ref.supabase.co';
const PUBLISHABLE_KEY = 'publishable-key';
const STORAGE_KEY = 'sb-project-ref-auth-token';

type MemoryStorage = {
  items: Map<string, string>;
  reads: string[];
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const items = new Map(Object.entries(initial));
  const reads: string[] = [];
  return {
    items,
    reads,
    getItem: async (key) => {
      reads.push(key);
      return items.get(key) ?? null;
    },
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
}

const state = vi.hoisted(() => ({
  appStorage: null as null | {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  },
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

vi.mock('../lib/env', () => ({
  env: { supabaseUrl: 'https://project-ref.supabase.co', supabasePublishableKey: 'publishable-key' },
  isMobileEnvConfigured: () => true,
}));

vi.mock('../lib/secure-session-storage', () => ({
  configureSecureSessionInvalidationHandler: () => () => undefined,
  createMemorySessionStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
  // The app's SecureStore adapter, standing in for each test's memory storage.
  secureSessionStorage: {
    getItem: (key: string) => state.appStorage!.getItem(key),
    setItem: (key: string, value: string) => state.appStorage!.setItem(key, value),
    removeItem: (key: string) => state.appStorage!.removeItem(key),
  },
}));

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

function user(id = 'user-1') {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'person@example.com',
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: {},
    identities: [],
    created_at: '2026-01-01T00:00:00Z',
  };
}

function sessionBody(accessToken = 'access-new') {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-new',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: user(),
  };
}

function storedSession(expiresInSeconds: number) {
  return JSON.stringify({
    ...sessionBody('access-stored'),
    refresh_token: 'refresh-stored',
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

/** Records every request and answers as Supabase Auth would. */
function fakeAuthServer() {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    requests.push({ method: init?.method ?? 'GET', url: url.href, headers, body });

    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/token') || url.pathname.endsWith('/signup')) return json(sessionBody());
    if (url.pathname.endsWith('/user')) return json(user());
    return json({ msg: 'not found' }, 404);
  });
  return { requests, fetchImpl };
}

/** The client `createClient` makes from the options lib/supabase.ts used to pass it. */
function createClientAuth(storage: MemoryStorage) {
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    global: { fetch: createSupabaseAuthFetch().fetch },
    auth: {
      storage,
      storageKey: STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      skipAutoInitialize: true,
    },
  }).auth;
}

async function appAuth(storage: MemoryStorage) {
  state.appStorage = storage;
  vi.resetModules();
  const module = await import('../lib/supabase');
  return module.supabase.auth;
}

const clients: GoTrueClient[] = [];

/**
 * Runs `scenario` against createClient's auth client and the app's, each over
 * its own copy of `stored`, and returns the requests each sent.
 */
async function runOnBoth(
  stored: Record<string, string>,
  scenario: (auth: GoTrueClient, storage: MemoryStorage) => Promise<unknown>,
) {
  const results: { requests: RecordedRequest[]; result: unknown; storage: MemoryStorage }[] = [];
  for (const build of [createClientAuth, appAuth] as const) {
    const server = fakeAuthServer();
    vi.stubGlobal('fetch', server.fetchImpl);
    const storage = memoryStorage(stored);
    const auth = await build(storage);
    clients.push(auth);
    const result = await scenario(auth, storage);
    await auth.stopAutoRefresh();
    results.push({ requests: server.requests, result, storage });
  }
  const [reference, app] = results;
  return { reference, app };
}

/** X-Client-Info names the library that sent a request, so it differs by design. */
function withoutClientInfo(requests: RecordedRequest[]) {
  return requests.map(({ headers, ...rest }) => {
    const { 'x-client-info': _clientInfo, ...kept } = headers;
    return { ...rest, headers: kept };
  });
}

function settingsOf(auth: GoTrueClient) {
  const client = auth as unknown as Record<string, unknown> & {
    admin: { url: string; headers: Record<string, string> };
    headers: Record<string, string>;
    lock: { name: string };
  };
  const { 'X-Client-Info': _clientInfo, ...headers } = client.headers;
  const { 'X-Client-Info': _adminClientInfo, ...adminHeaders } = client.admin.headers;
  return {
    url: client.url,
    headers,
    adminUrl: client.admin.url,
    adminHeaders,
    storageKey: client.storageKey,
    flowType: client.flowType,
    autoRefreshToken: client.autoRefreshToken,
    persistSession: client.persistSession,
    detectSessionInUrl: client.detectSessionInUrl,
    hasCustomAuthorizationHeader: client.hasCustomAuthorizationHeader,
    throwOnError: Boolean(client.throwOnError),
    userStorage: client.userStorage,
    lock: client.lock.name,
    // createClient passes it unset, which auth-js reads as no time limit on its
    // lock; that lock is navigator.locks on the web build (a no-op on native).
    lockAcquireTimeout: client.lockAcquireTimeout,
    initializePromise: client.initializePromise,
  };
}

/** The PKCE verifier auth-js keeps for a sign-in under way (JSON, `verifier[/type]`). */
function storedVerifier(storage: MemoryStorage) {
  return (JSON.parse(storage.items.get(`${STORAGE_KEY}-code-verifier`) ?? 'null') as string).split('/')[0];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((auth) => auth.stopAutoRefresh()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the app builds only the Supabase Auth client', () => {
  const root = path.resolve(__dirname, '..');

  it('never imports supabase-js in app code', () => {
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          if (/['"]@supabase\/(supabase-js|postgrest-js|realtime-js|storage-js|functions-js)['"]/.test(source)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    for (const dir of ['app', 'components', 'lib']) visit(path.join(root, dir));
    expect(offenders).toEqual([]);
  });

  it('declares auth-js as the dependency and keeps supabase-js for tests only', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.dependencies['@supabase/auth-js']).toBeDefined();
    expect(packageJson.dependencies['@supabase/supabase-js']).toBeUndefined();
  });

  it('names the installed auth-js in X-Client-Info', async () => {
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules/@supabase/auth-js/package.json'), 'utf8'),
    ).version;
    const module = await (state.appStorage = memoryStorage(), vi.resetModules(), import('../lib/supabase'));
    expect(module.AUTH_JS_VERSION).toBe(installed);
    expect((module.supabase.auth as unknown as { headers: Record<string, string> }).headers['X-Client-Info'])
      .toBe(`auth-js-react-native/${installed}`);
  });
});

describe('the app auth client matches the one createClient made', () => {
  it('has the same URL, keys, storage and auth options', async () => {
    const referenceStorage = memoryStorage();
    const appStorage = memoryStorage();
    const reference = createClientAuth(referenceStorage);
    const app = await appAuth(appStorage);
    clients.push(reference, app);

    expect(settingsOf(app)).toEqual(settingsOf(reference));
    expect(settingsOf(app)).toMatchObject({
      url: `${SUPABASE_URL}/auth/v1`,
      headers: { Authorization: `Bearer ${PUBLISHABLE_KEY}`, apikey: PUBLISHABLE_KEY },
      storageKey: STORAGE_KEY,
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      lock: 'lockNoOp',
      lockAcquireTimeout: undefined,
      initializePromise: null,
    });
    expect((reference as unknown as { storage: unknown }).storage).toBe(referenceStorage);
    expect((app as unknown as { storage: { getItem: unknown } }).storage.getItem).toBeTypeOf('function');
  });

  it('reads nothing at construction, where createClient read the stored session for Realtime', async () => {
    const stored = { [STORAGE_KEY]: storedSession(3600) };
    const referenceStorage = memoryStorage(stored);
    const appStorage = memoryStorage(stored);
    clients.push(createClientAuth(referenceStorage), await appAuth(appStorage));
    await sleep(20);

    expect(referenceStorage.reads).toEqual([STORAGE_KEY]);
    expect(appStorage.reads).toEqual([]);
  });

  it('starts Google sign-in with the same authorize URL and keeps its code verifier the same way', async () => {
    const redirectTo = 'magicbooklet://oauth/callback';
    const { reference, app } = await runOnBoth({}, async (auth) => auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    }));

    for (const side of [reference, app]) {
      const { data, error } = side.result as Awaited<ReturnType<GoTrueClient['signInWithOAuth']>>;
      expect(error).toBeNull();
      const url = new URL(data.url!);
      const verifier = storedVerifier(side.storage);
      expect(verifier).toMatch(/^[0-9a-f]{56,}$/);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      expect(url.searchParams.get('code_challenge')).toBe(challenge);
    }
    const normalized = (side: typeof reference) => {
      const url = new URL((side.result as { data: { url: string } }).data.url);
      url.searchParams.set('code_challenge', '<challenge>');
      return url.href;
    };
    expect(normalized(app)).toBe(normalized(reference));
    expect(normalized(app)).toBe(
      `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`
        + '&code_challenge=%3Cchallenge%3E&code_challenge_method=s256',
    );
    expect(app.requests).toEqual([]);
    expect(reference.requests).toEqual([]);
  });

  it('exchanges the Google code with the same request and stores the same session', async () => {
    const { reference, app } = await runOnBoth({}, async (auth, storage) => {
      await auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'magicbooklet://oauth/callback', skipBrowserRedirect: true },
      });
      const verifier = storedVerifier(storage);
      const result = await auth.exchangeCodeForSession('auth-code');
      return { result, verifier };
    });

    for (const side of [reference, app]) {
      const { result, verifier } = side.result as {
        result: Awaited<ReturnType<GoTrueClient['exchangeCodeForSession']>>;
        verifier: string;
      };
      expect(result.error).toBeNull();
      expect(result.data.session?.access_token).toBe('access-new');
      expect(side.requests).toHaveLength(1);
      expect(side.requests[0].body).toEqual({ auth_code: 'auth-code', code_verifier: verifier });
      side.requests[0].body = { auth_code: 'auth-code', code_verifier: '<verifier>' };
      expect(JSON.parse(side.storage.items.get(STORAGE_KEY)!).access_token).toBe('access-new');
      expect(side.storage.items.has(`${STORAGE_KEY}-code-verifier`)).toBe(false);
    }
    expect(withoutClientInfo(app.requests)).toEqual(withoutClientInfo(reference.requests));
    expect(app.requests[0]).toMatchObject({
      method: 'POST',
      url: `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`,
      headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${PUBLISHABLE_KEY}` },
    });
  });

  it.each([
    ['Apple', (auth: GoTrueClient) => auth.signInWithIdToken({ provider: 'apple', token: 'apple-id-token', nonce: 'raw-nonce' })],
    ['a password', (auth: GoTrueClient) => auth.signInWithPassword({ email: 'person@example.com', password: 'Secret-1!' })],
    ['a guest session', (auth: GoTrueClient) => auth.signInAnonymously()],
  ])('signs in with %s through the same request', async (_label, signIn) => {
    const { reference, app } = await runOnBoth({}, async (auth) => {
      const result = await signIn(auth);
      return { error: result.error, token: result.data.session?.access_token };
    });

    expect(app.result).toEqual({ error: null, token: 'access-new' });
    expect(reference.result).toEqual(app.result);
    expect(app.requests).toHaveLength(1);
    expect(withoutClientInfo(app.requests)).toEqual(withoutClientInfo(reference.requests));
    expect(app.storage.items.get(STORAGE_KEY)).toBeDefined();
  });

  it('saves a name, reads the user and refreshes on demand through the same requests', async () => {
    const { reference, app } = await runOnBoth({ [STORAGE_KEY]: storedSession(3600) }, async (auth) => {
      await auth.initialize();
      const updated = await auth.updateUser({ data: { full_name: 'Some One' } });
      const fetched = await auth.getUser();
      const refreshed = await auth.refreshSession();
      return [updated.error, fetched.error, refreshed.error, refreshed.data.session?.access_token];
    });

    expect(app.result).toEqual([null, null, null, 'access-new']);
    expect(reference.result).toEqual(app.result);
    expect(app.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT ${SUPABASE_URL}/auth/v1/user`,
      `GET ${SUPABASE_URL}/auth/v1/user`,
      `POST ${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    ]);
    expect(withoutClientInfo(app.requests)).toEqual(withoutClientInfo(reference.requests));
    expect(app.requests[0].headers.authorization).toBe('Bearer access-stored');
  });

  it('refreshes an expired stored session once at launch, as before', async () => {
    const { reference, app } = await runOnBoth({ [STORAGE_KEY]: storedSession(-60) }, async (auth) => {
      await sleep(10);
      await auth.initialize();
      const { data } = await auth.getSession();
      await sleep(20);
      return data.session?.access_token;
    });

    expect(app.result).toBe('access-new');
    expect(reference.result).toBe('access-new');
    expect(app.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    ]);
    expect(withoutClientInfo(app.requests)).toEqual(withoutClientInfo(reference.requests));
    expect(app.requests[0].body).toEqual({ refresh_token: 'refresh-stored' });
  });

  it.each(['local', 'global'] as const)('signs out (%s) through the same request and clears the session', async (scope) => {
    const { reference, app } = await runOnBoth({ [STORAGE_KEY]: storedSession(3600) }, async (auth) => {
      await auth.initialize();
      await auth.stopAutoRefresh();
      const { error } = await auth.signOut({ scope });
      await auth.startAutoRefresh();
      return error;
    });

    expect(app.result).toBeNull();
    expect(reference.result).toBeNull();
    expect(withoutClientInfo(app.requests)).toEqual(withoutClientInfo(reference.requests));
    expect(app.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${SUPABASE_URL}/auth/v1/logout?scope=${scope}`,
    ]);
    expect(app.requests[0].headers.authorization).toBe('Bearer access-stored');
    expect(app.storage.items.has(STORAGE_KEY)).toBe(false);
    expect(reference.storage.items.has(STORAGE_KEY)).toBe(false);
  });
});

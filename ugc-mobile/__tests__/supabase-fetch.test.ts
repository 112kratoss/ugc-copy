import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupabaseAuthFetch } from '../lib/supabase-fetch';

const SUPABASE_URL = 'https://project-ref.supabase.co';
const STORAGE_KEY = 'sb-project-ref-auth-token';
const LOGOUT_URL = `${SUPABASE_URL}/auth/v1/logout?scope=local`;
const REFRESH_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
const PASSWORD_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
const ID_TOKEN_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=id_token`;
const PKCE_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`;
const SIGN_UP_URL = `${SUPABASE_URL}/auth/v1/signup`;
const USER_URL = `${SUPABASE_URL}/auth/v1/user`;

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
  };
}

// An hour of validity keeps auth-js from refreshing before it logs out, so
// the only request a sign-out makes is the logout itself.
function storedSession() {
  return JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  });
}

// A network that accepts a request and never answers it. Only an abort ends
// the wait, which is what React Native's Android client does with no timeout.
function stalledFetch() {
  return vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('The operation was aborted.', 'AbortError')),
      { once: true },
    );
  }));
}

function clientWith(fetchImpl: typeof fetch, storage: ReturnType<typeof memoryStorage>) {
  return createClient(SUPABASE_URL, 'publishable-key', {
    global: { fetch: fetchImpl },
    auth: {
      storage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      skipAutoInitialize: true,
    },
  });
}

function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('Supabase auth requests during sign-out', () => {
  beforeEach(() => {
    // auth-js logs every failed request before it converts the failure.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows why the deadline exists: a stalled logout holds the auth lock, so getSession waits too', async () => {
    const client = clientWith(stalledFetch() as unknown as typeof fetch, memoryStorage({ [STORAGE_KEY]: storedSession() }));

    const signOut = client.auth.signOut({ scope: 'local' });
    const getSession = client.auth.getSession();

    expect(await settlesWithin(signOut, 200)).toBe(false);
    expect(await settlesWithin(getSession, 50)).toBe(false);
  });

  it('with the deadline, a stalled logout returns a retryable error and releases the lock', async () => {
    const storage = memoryStorage({ [STORAGE_KEY]: storedSession() });
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 50,
    });
    const client = clientWith(authFetch, storage);

    const { error } = await client.auth.signOut({ scope: 'local' });

    expect(isAuthRetryableFetchError(error)).toBe(true);
    expect(await settlesWithin(client.auth.getSession(), 200)).toBe(true);
    // auth-js keeps the session after a retryable failure; whether the phone
    // signs out anyway is the app's decision, made in lib/auth.tsx.
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
  });
});

type SignIn = (client: ReturnType<typeof clientWith>) => Promise<{ error: unknown }>;

const stalledSignIns: [string, SignIn][] = [
  ['a password sign-in', (client) => client.auth.signInWithPassword({ email: 'person@example.com', password: 'Secret-pass-1' })],
  ['an Apple id_token sign-in', (client) => client.auth.signInWithIdToken({ provider: 'apple', token: 'apple-id-token', nonce: 'raw-nonce' })],
  // auth-js runs the exchange inside its lock.
  ['a Google PKCE exchange', (client) => client.auth.exchangeCodeForSession('auth-code')],
  ['a guest\'s anonymous sign-up', (client) => client.auth.signInAnonymously()],
];

describe('Supabase sign-ins on a stalled network', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(stalledSignIns)('ends %s with a retryable error, keeps the stored session and frees the lock', async (_name, signIn) => {
    // A guest signing in still holds its own session, which a failed attempt must leave alone.
    const session = storedSession();
    const storage = memoryStorage({
      [STORAGE_KEY]: session,
      [`${STORAGE_KEY}-code-verifier`]: 'code-verifier',
    });
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 50,
    });
    const client = clientWith(authFetch, storage);

    const { error } = await signIn(client);

    expect(isAuthRetryableFetchError(error)).toBe(true);
    expect(storage.items.get(STORAGE_KEY)).toBe(session);
    expect(await settlesWithin(client.auth.getSession(), 200)).toBe(true);
  });

  // The account's "Set up later" record and the name Apple shares are written
  // through updateUser, which waits in the same lock.
  it('ends an updateUser with a retryable error, keeps the stored session and frees the lock', async () => {
    const session = storedSession();
    const storage = memoryStorage({ [STORAGE_KEY]: session });
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 50,
    });
    const client = clientWith(authFetch, storage);

    const { error } = await client.auth.updateUser({ data: { creator_profile_onboarding_skipped_version: 1 } });

    expect(isAuthRetryableFetchError(error)).toBe(true);
    expect(storage.items.get(STORAGE_KEY)).toBe(session);
    expect(await settlesWithin(client.auth.getSession(), 200)).toBe(true);
  });
});

describe('createSupabaseAuthFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function track(request: Promise<Response>) {
    const state = { outcome: 'pending' as 'pending' | 'resolved' | 'aborted' | 'rejected' };
    request.then(
      () => {
        state.outcome = 'resolved';
      },
      (error: unknown) => {
        state.outcome = (error as Error)?.name === 'AbortError' ? 'aborted' : 'rejected';
      },
    );
    return state;
  }

  it('aborts a logout that outlives the deadline', async () => {
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 1000,
    });

    const logout = track(authFetch(LOGOUT_URL, { method: 'POST' }));

    await vi.advanceTimersByTimeAsync(999);
    expect(logout.outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(logout.outcome).toBe('aborted');
  });

  it('leaves a token refresh alone outside a sign-out', async () => {
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 1000,
    });

    const refresh = track(authFetch(REFRESH_URL, { method: 'POST' }));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh.outcome).toBe('pending');
  });

  it('aborts token refreshes during a sign-out, including one already in flight when it starts', async () => {
    const { fetch: authFetch, duringSignOut } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 1000,
    });
    const inFlight = track(authFetch(REFRESH_URL, { method: 'POST' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inFlight.outcome).toBe('pending');

    let started: ReturnType<typeof track> | undefined;
    const signOut = duringSignOut(async () => {
      started = track(authFetch(REFRESH_URL, { method: 'POST' }));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(inFlight.outcome).toBe('aborted');
    expect(started?.outcome).toBe('aborted');

    await vi.advanceTimersByTimeAsync(2_000);
    await signOut;
    const afterwards = track(authFetch(REFRESH_URL, { method: 'POST' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(afterwards.outcome).toBe('pending');
  });

  it.each([
    ['a password sign-in', PASSWORD_URL],
    ['an Apple id_token sign-in', ID_TOKEN_URL],
    ['a Google PKCE exchange', PKCE_URL],
    ['an anonymous sign-up', SIGN_UP_URL],
  ])('aborts %s that outlives the deadline, with no sign-out running', async (_name, url) => {
    const fetcher = stalledFetch();
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: fetcher as unknown as typeof fetch,
      deadlineMs: 1000,
    });
    const body = '{"email":"person@example.com"}';

    const signIn = track(authFetch(url, { method: 'POST', body }));

    await vi.advanceTimersByTimeAsync(999);
    expect(signIn.outcome).toBe('pending');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body });
    await vi.advanceTimersByTimeAsync(1);
    expect(signIn.outcome).toBe('aborted');
  });

  it('aborts an updateUser (PUT /user) that outlives the deadline, with no sign-out running', async () => {
    const fetcher = stalledFetch();
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: fetcher as unknown as typeof fetch,
      deadlineMs: 1000,
    });
    const body = '{"data":{"creator_profile_onboarding_skipped_version":1}}';

    const update = track(authFetch(USER_URL, { method: 'PUT', body }));

    await vi.advanceTimersByTimeAsync(999);
    expect(update.outcome).toBe('pending');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PUT', body });
    await vi.advanceTimersByTimeAsync(1);
    expect(update.outcome).toBe('aborted');
  });

  it('passes every other request through with the caller\'s own arguments', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const { fetch: authFetch, duringSignOut } = createSupabaseAuthFetch({
      fetcher: fetcher as unknown as typeof fetch,
      deadlineMs: 1000,
    });
    // A read of the user is not an update: it keeps the caller's arguments.
    const read = { method: 'GET' };
    const init = { method: 'PUT', body: '{}' };

    await duringSignOut(async () => {
      await authFetch(USER_URL, read);
      await authFetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`, init);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual([USER_URL, read]);
    expect((fetcher.mock.calls[0] as unknown[])[1]).toBe(read);
    expect((fetcher.mock.calls[1] as unknown[])[1]).toBe(init);
  });

  it('clears the deadline as soon as the response arrives', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: fetcher as unknown as typeof fetch,
      deadlineMs: 1000,
    });

    await authFetch(new URL(LOGOUT_URL), { method: 'POST' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a caller abort through', async () => {
    const { fetch: authFetch } = createSupabaseAuthFetch({
      fetcher: stalledFetch() as unknown as typeof fetch,
      deadlineMs: 60_000,
    });
    const caller = new AbortController();

    const logout = track(authFetch(LOGOUT_URL, { method: 'POST', signal: caller.signal }));
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(logout.outcome).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });
});

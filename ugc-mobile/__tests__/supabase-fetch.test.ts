import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupabaseAuthFetch } from '../lib/supabase-fetch';

const SUPABASE_URL = 'https://project-ref.supabase.co';
const STORAGE_KEY = 'sb-project-ref-auth-token';
const LOGOUT_URL = `${SUPABASE_URL}/auth/v1/logout?scope=global`;
const REFRESH_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;
const SIGN_IN_URL = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

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

    const signOut = client.auth.signOut();
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

    const { error } = await client.auth.signOut();

    expect(isAuthRetryableFetchError(error)).toBe(true);
    expect(await settlesWithin(client.auth.getSession(), 200)).toBe(true);
    // auth-js keeps the session after a retryable failure; whether the phone
    // signs out anyway is the app's decision, made in lib/auth.tsx.
    expect(storage.items.has(STORAGE_KEY)).toBe(true);
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

  it('passes sign-in and every other request through with the caller\'s own arguments', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const { fetch: authFetch, duringSignOut } = createSupabaseAuthFetch({
      fetcher: fetcher as unknown as typeof fetch,
      deadlineMs: 1000,
    });
    const init = { method: 'POST', body: '{}' };

    await duringSignOut(async () => {
      await authFetch(SIGN_IN_URL, init);
      await authFetch(`${SUPABASE_URL}/rest/v1/profiles?select=id`, init);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual([SIGN_IN_URL, init]);
    expect((fetcher.mock.calls[0] as unknown[])[1]).toBe(init);
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

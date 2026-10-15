import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ssrMocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn(() => ({ auth: {} })),
}));

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: ssrMocks.createBrowserClient,
}));

const LOGOUT_URL = 'https://project-ref.supabase.co/auth/v1/logout?scope=local';

/** A fetch that never answers until aborted, as a stalled logout behaves. */
function stalledFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
}

// Audit 04-4: the browser gives a request no deadline of its own, so a stalled
// logout held the account menu's sign-out with nothing on screen.
describe('the browser Supabase client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is created with the fetch that bounds the logout call', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project-ref.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    vi.resetModules();

    await import('@/lib/supabase');

    expect(ssrMocks.createBrowserClient).toHaveBeenCalledWith(
      'https://project-ref.supabase.co',
      'anon-key',
      { global: { fetch: expect.any(Function) } },
    );
  });

  it('gives up on a logout after ten seconds', async () => {
    const { createLogoutDeadlineFetch, LOGOUT_REQUEST_DEADLINE_MS } = await import('@/lib/supabase');
    const fetcher = stalledFetch();
    const logout = createLogoutDeadlineFetch({ fetcher })(LOGOUT_URL, { method: 'POST' });
    const settled = vi.fn();
    logout.then(settled, settled);

    await vi.advanceTimersByTimeAsync(LOGOUT_REQUEST_DEADLINE_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(logout).rejects.toThrow('Supabase logout timed out after 10000ms');
    expect(LOGOUT_REQUEST_DEADLINE_MS).toBe(10_000);
    expect(fetcher).toHaveBeenCalledWith(LOGOUT_URL, expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
  });

  it('stands down once the logout answers', async () => {
    const { createLogoutDeadlineFetch } = await import('@/lib/supabase');
    const response = new Response(null, { status: 204 });
    const fetcher = vi.fn<typeof fetch>(async () => response);

    await expect(createLogoutDeadlineFetch({ fetcher })(new URL(LOGOUT_URL), { method: 'POST' })).resolves.toBe(response);

    const signal = fetcher.mock.calls[0][1]?.signal;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
  });

  it('passes the caller\'s own abort on to the logout', async () => {
    const { createLogoutDeadlineFetch } = await import('@/lib/supabase');
    const fetcher = stalledFetch();
    const caller = new AbortController();
    const logout = createLogoutDeadlineFetch({ fetcher })(LOGOUT_URL, { method: 'POST', signal: caller.signal });

    caller.abort(new Error('left the page'));

    await expect(logout).rejects.toThrow('left the page');
  });

  // A refresh cut short is retried with a refresh token the server may already
  // have rotated, which signs the person out.
  it.each([
    'https://project-ref.supabase.co/auth/v1/token?grant_type=refresh_token',
    'https://project-ref.supabase.co/auth/v1/user',
    'https://project-ref.supabase.co/rest/v1/profiles?select=credits',
  ])('leaves %s untouched', async (url) => {
    const { createLogoutDeadlineFetch } = await import('@/lib/supabase');
    const fetcher = stalledFetch();
    const init = { method: 'GET' };

    void createLogoutDeadlineFetch({ fetcher })(url, init);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetcher).toHaveBeenCalledWith(url, init);
  });
});

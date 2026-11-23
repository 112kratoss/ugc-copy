import { AuthApiError, AuthRetryableFetchError, createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, HEAD } from '@/app/api/showcase/feed/route';
import { logBackendRouteError } from '@/lib/backend-logger';
import { evaluateUserFacingRouteIdentity } from '@/lib/route-identity-admission';
import { getShowcaseFeedPage } from '@/lib/showcase-feed';

// The real feed exports, admission and handler, with the network at the edges: the identity
// client's two calls (local verification, the lifecycle round trip), the service client's read
// limit, and the feed page.
const mocks = vi.hoisted(() => ({
  limiterRpc: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@supabase/supabase-js', async (original) => ({
  ...await original<typeof import('@supabase/supabase-js')>(),
  createClient: vi.fn(),
}));
vi.mock('@/lib/server-helpers', async () => {
  const { registerIdentityAdmissionContext } = await import('@/lib/identity-admission-assertion');
  return {
    createServiceClient: () => ({ rpc: mocks.limiterRpc }),
    createUserClient: (request: Request) => {
      const client = { auth: { getUser: mocks.getUser } };
      registerIdentityAdmissionContext(client, request);
      return client;
    },
  };
});
vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedPage: vi.fn(async () => ({
    items: [],
    pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
  })),
  prepareShowcaseFeedReadAhead: vi.fn(async () => null),
}));
vi.mock('@/lib/backend-logger', async (original) => ({
  ...await original<typeof import('@/lib/backend-logger')>(),
  logBackendRouteError: vi.fn(),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '33333333-3333-4333-8333-333333333333';
const ACTIVE = { state: 'active', session_valid: true, banned: false, created_at: '2026-09-21T00:00:00Z' };
const RESET_AT = '2026-11-23T10:10:00.000Z';
const ALLOWED = { allowed: true, limit: 60, remaining: 59, retryAfterSeconds: 0, resetAt: RESET_AT };
const EXHAUSTED = { allowed: false, limit: 60, remaining: 0, retryAfterSeconds: 42, resetAt: RESET_AT };

type RpcAnswer = { data: unknown; error: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    is_anonymous: false,
    session_id: '22222222-2222-4222-8222-222222222222',
    exp: Math.floor(Date.now() / 1000) + 3_600,
    ...overrides,
  };
}

function identityClient({
  tokenClaims = claims(),
  claimsError,
  lifecycle = () => Promise.resolve({ data: ACTIVE, error: null }),
}: {
  tokenClaims?: Record<string, unknown>;
  claimsError?: unknown;
  lifecycle?: () => Promise<RpcAnswer>;
} = {}) {
  return {
    auth: {
      getClaims: vi.fn(async () => (
        claimsError ? { data: null, error: claimsError } : { data: { claims: tokenClaims }, error: null }
      )),
    },
    rpc: vi.fn((name: string) => {
      if (name !== 'current_identity_admission') throw new Error(`unexpected rpc ${name}`);
      return lifecycle();
    }),
  };
}

function useIdentity(client: ReturnType<typeof identityClient>) {
  vi.mocked(createClient).mockReturnValue(client as unknown as ReturnType<typeof createClient>);
  return client;
}

function feedRequest(
  query = 'sort=for-you',
  { method = 'GET', authorization = 'Bearer user-token' as string | null } = {},
) {
  return new NextRequest(`https://magicbooklet.test/api/showcase/feed?${query}`, {
    method,
    headers: authorization === null ? {} : { authorization },
  });
}

/** Lets every promise chain already in flight run its course. */
async function letPendingWorkRun() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function countedUnder(): Array<Record<string, unknown>> {
  return mocks.limiterRpc.mock.calls.map(([name, args]) => ({ name, ...args as Record<string, unknown> }));
}

describe('the feed read limit beside route-owned admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'feed-read-limit-test-secret-at-least-32-characters');
    mocks.limiterRpc.mockImplementation(async () => ({ data: ALLOWED, error: null }));
    // With the assertion key set, the handler reads its viewer from the assertion, never Auth.
    mocks.getUser.mockImplementation(async () => {
      throw new Error('getUser is not expected while the assertion key is set');
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('counts a signed-in read while the lifecycle round trip is still out, and serves it once both are in', async () => {
    const lifecycle = deferred<RpcAnswer>();
    const count = deferred<RpcAnswer>();
    const identity = useIdentity(identityClient({ lifecycle: () => lifecycle.promise }));
    mocks.limiterRpc.mockImplementation(() => count.promise);

    const pending = GET(feedRequest());

    // Both round trips are out at once and neither has answered: the count did not wait for
    // the lifecycle answer.
    await vi.waitFor(() => {
      expect(identity.rpc).toHaveBeenCalledWith('current_identity_admission');
      expect(mocks.limiterRpc).toHaveBeenCalledWith('check_backend_rate_limit', {
        p_scope: 'showcase-feed:for-you-read',
        p_subject_key: USER_ID,
        p_limit: 60,
        p_window_seconds: 600,
      });
    });
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();

    lifecycle.resolve({ data: ACTIVE, error: null });
    await letPendingWorkRun();
    // Admitted, and still waiting for the count: no feed work before both are in.
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();

    count.resolve({ data: ALLOWED, error: null });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(getShowcaseFeedPage).toHaveBeenCalledOnce();
    expect(vi.mocked(getShowcaseFeedPage).mock.calls[0][0]).toMatchObject({ viewerUserId: USER_ID, sort: 'for-you' });
    // Counted once: the handler read the count started beside admission instead of its own.
    expect(mocks.limiterRpc).toHaveBeenCalledOnce();
    expect(identity.rpc).toHaveBeenCalledOnce();
  });

  it('starts no feed work while admission is out, even once the count has answered', async () => {
    const lifecycle = deferred<RpcAnswer>();
    useIdentity(identityClient({ lifecycle: () => lifecycle.promise }));

    const pending = GET(feedRequest());
    await vi.waitFor(() => expect(mocks.limiterRpc).toHaveBeenCalledOnce());
    await letPendingWorkRun();
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();

    lifecycle.resolve({ data: ACTIVE, error: null });
    expect((await pending).status).toBe(200);
    expect(getShowcaseFeedPage).toHaveBeenCalledOnce();
  });

  it('runs a HEAD through the same boundary', async () => {
    const lifecycle = deferred<RpcAnswer>();
    const identity = useIdentity(identityClient({ lifecycle: () => lifecycle.promise }));

    const pending = HEAD(feedRequest('sort=for-you', { method: 'HEAD' }));
    await vi.waitFor(() => {
      expect(identity.rpc).toHaveBeenCalledOnce();
      expect(mocks.limiterRpc).toHaveBeenCalledOnce();
    });
    lifecycle.resolve({ data: ACTIVE, error: null });
    expect((await pending).status).toBe(200);
    expect(mocks.limiterRpc).toHaveBeenCalledOnce();
  });

  // Every answer the lifecycle round trip can refuse with, each against every answer the count
  // can give: admission's refusal is the answer, exactly as admission alone gives it.
  const LIFECYCLE_REFUSALS: Array<[string, () => Promise<RpcAnswer>, number, string]> = [
    ['an account that no longer exists', () => Promise.resolve({ data: null, error: null }), 401, 'UNAUTHORIZED'],
    ['a revoked session', () => Promise.resolve({ data: { ...ACTIVE, session_valid: false }, error: null }), 401, 'UNAUTHORIZED'],
    ['a banned account', () => Promise.resolve({ data: { ...ACTIVE, banned: true }, error: null }), 401, 'UNAUTHORIZED'],
    ['a guest since linked to an account', () => Promise.resolve({ data: { ...ACTIVE, state: 'merged' }, error: null }), 409, 'SESSION_MERGED'],
    [
      'an account being deleted, on its revoked session',
      () => Promise.resolve({ data: { ...ACTIVE, state: 'deleting', session_valid: false }, error: null }),
      409,
      'ACCOUNT_DELETING',
    ],
    ['an unknown lifecycle state', () => Promise.resolve({ data: { ...ACTIVE, state: 'suspended' }, error: null }), 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    ['a lifecycle answer that is not a record', () => Promise.resolve({ data: 'active', error: null }), 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    ['a failed lifecycle read', () => Promise.resolve({ data: null, error: { message: 'connection reset' } }), 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    ['a lifecycle read that throws', () => Promise.reject(new Error('socket hang up')), 503, 'IDENTITY_CHECK_UNAVAILABLE'],
  ];
  const COUNT_ANSWERS: Array<[string, () => Promise<RpcAnswer>]> = [
    ['allowed', () => Promise.resolve({ data: ALLOWED, error: null })],
    ['over the limit', () => Promise.resolve({ data: EXHAUSTED, error: null })],
    ['failed', () => Promise.resolve({ data: null, error: { message: 'limiter down' } })],
    ['thrown', () => Promise.reject(new Error('fetch failed'))],
  ];

  describe.each(LIFECYCLE_REFUSALS)('for %s', (_case, lifecycle, status, code) => {
    it.each(COUNT_ANSWERS)('answers exactly as admission alone does when the count is %s', async (_answer, count) => {
      const alone = await evaluateUserFacingRouteIdentity(feedRequest(), {
        createUserClient: () => identityClient({ lifecycle }),
      });
      useIdentity(identityClient({ lifecycle }));
      mocks.limiterRpc.mockImplementation(count);

      const response = await GET(feedRequest());

      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toEqual({ error: expect.any(String), code });
      expect(response.status).toBe(alone.rejection!.status);
      expect(body).toEqual(await alone.rejection!.json());
      expect([...response.headers]).toEqual([...alone.rejection!.headers]);
      expect(getShowcaseFeedPage).not.toHaveBeenCalled();
      // Nothing the count answered is read or logged.
      expect(logBackendRouteError).not.toHaveBeenCalled();
    });

    // What a refused session does to the limiter now that both run together: the count went
    // out before the refusal was known, so the read stays counted, once, against the token's
    // own verified subject; never against a network's key or another account's.
    it('keeps the refused read counted once, against the token\'s own subject', async () => {
      useIdentity(identityClient({ lifecycle }));

      await GET(feedRequest());

      expect(countedUnder()).toEqual([{
        name: 'check_backend_rate_limit',
        p_scope: 'showcase-feed:for-you-read',
        p_subject_key: USER_ID,
        p_limit: 60,
        p_window_seconds: 600,
      }]);
    });
  });

  it.each([
    ['a token that fails its signature or expiry', { claimsError: new AuthApiError('invalid JWT', 401, 'bad_jwt') }, null, 401, 'UNAUTHORIZED'],
    ['a token whose signing keys cannot be fetched', { claimsError: new AuthRetryableFetchError('fetch failed', 0) }, null, 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    ['a malformed Authorization header', {}, 'Token user-token', 401, 'UNAUTHORIZED'],
    ['a subject that is not a user id', { tokenClaims: claims({ sub: 'not-a-user-id' }) }, null, 401, 'UNAUTHORIZED'],
    ['a token without the authenticated role', { tokenClaims: claims({ role: 'anon' }) }, null, 401, 'UNAUTHORIZED'],
    ['an agent\'s token', { tokenClaims: claims({ client_id: 'client-claude' }) }, null, 403, 'AGENT_TOKEN_NOT_ALLOWED'],
  ] as const)('refuses %s before anything is counted', async (_case, options, authorization, status, code) => {
    const identity = useIdentity(identityClient(options));

    const response = await GET(feedRequest('sort=for-you', { authorization: authorization ?? 'Bearer user-token' }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: expect.any(String), code });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(identity.rpc).not.toHaveBeenCalled();
    expect(mocks.limiterRpc).not.toHaveBeenCalled();
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();
  });

  it('answers an exhausted read limit with its 429 once admission passes', async () => {
    useIdentity(identityClient());
    mocks.limiterRpc.mockImplementation(async () => ({ data: EXHAUSTED, error: null }));

    const response = await GET(feedRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: expect.any(String),
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 60,
      resetAt: RESET_AT,
    });
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBe(RESET_AT);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();
    expect(mocks.limiterRpc).toHaveBeenCalledOnce();
  });

  it.each([
    ['answers with an error', () => Promise.resolve({ data: null, error: { message: 'limiter down' } })],
    ['throws', () => Promise.reject(new Error('fetch failed'))],
  ])('answers a count that %s with the 500 it always has, once admission passes', async (_case, count) => {
    useIdentity(identityClient());
    mocks.limiterRpc.mockImplementation(count);

    const response = await GET(feedRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to check feed request limits.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(logBackendRouteError).toHaveBeenCalledWith('Showcase feed rate limit failed:', expect.anything());
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();
  });

  it.each([
    ['sort=for-you', 'showcase-feed:for-you-read', 60],
    ['sort=recent', 'showcase-feed:read', 240],
    ['sort=top-sales&cursor=abc', 'showcase-feed:read', 240],
    ['sort=for-you&offset=12', 'showcase-feed:for-you-read', 60],
    // A read-ahead the handler serves is counted against the ranked lane, as before.
    ['sort=for-you&readAhead=1', 'showcase-feed:for-you-read', 60],
  ])('counts %s once, under the limit and key the handler uses', async (query, scope, limit) => {
    useIdentity(identityClient());

    const response = await GET(feedRequest(query));

    expect(response.status).toBe(200);
    expect(countedUnder()).toEqual([{
      name: 'check_backend_rate_limit',
      p_scope: scope,
      p_subject_key: USER_ID,
      p_limit: limit,
      p_window_seconds: 600,
    }]);
  });

  it.each([
    'sort=recent&readAhead=1',
    'sort=for-you&offset=12&readAhead=1',
    'sort=for-you&cursor=abc&readAhead=1',
  ])('counts nothing for a read-ahead the handler refuses before counting (%s)', async (query) => {
    useIdentity(identityClient());

    const response = await GET(feedRequest(query));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'READ_AHEAD_UNSUPPORTED' });
    expect(mocks.limiterRpc).not.toHaveBeenCalled();
    expect(getShowcaseFeedPage).not.toHaveBeenCalled();
  });

  it('counts a guest\'s read under the guest\'s own id', async () => {
    useIdentity(identityClient({ tokenClaims: claims({ sub: GUEST_ID, is_anonymous: true }) }));

    const response = await GET(feedRequest());

    expect(response.status).toBe(200);
    expect(countedUnder()).toEqual([expect.objectContaining({ p_subject_key: GUEST_ID })]);
    expect(vi.mocked(getShowcaseFeedPage).mock.calls[0][0]).toMatchObject({ viewerUserId: GUEST_ID });
  });

  it('counts a read that sends no token by its network, in the handler, as before', async () => {
    const response = await GET(feedRequest('sort=recent', { authorization: null }));

    expect(response.status).toBe(200);
    expect(createClient).not.toHaveBeenCalled();
    expect(countedUnder()).toEqual([expect.objectContaining({ p_scope: 'showcase-feed:read' })]);
    expect(countedUnder()[0].p_subject_key).not.toBe(USER_ID);
  });

  describe('without the assertion key (a rolling or misconfigured deploy)', () => {
    beforeEach(() => vi.stubEnv('IDENTITY_ADMISSION_SECRET', ''));

    it('uses the count started beside admission when the handler\'s own sign-in check names the same account', async () => {
      useIdentity(identityClient());
      mocks.getUser.mockImplementation(async () => ({ data: { user: { id: USER_ID } }, error: null }));

      const response = await GET(feedRequest());

      expect(response.status).toBe(200);
      expect(mocks.getUser).toHaveBeenCalledOnce();
      expect(mocks.limiterRpc).toHaveBeenCalledOnce();
    });

    it('answers the handler\'s 401 as before, with that read counted once against the token\'s subject', async () => {
      useIdentity(identityClient());
      mocks.getUser.mockImplementation(async () => ({ data: { user: null }, error: new Error('session not found') }));

      const response = await GET(feedRequest());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Authentication required.' });
      expect(countedUnder()).toEqual([expect.objectContaining({ p_subject_key: USER_ID })]);
      expect(getShowcaseFeedPage).not.toHaveBeenCalled();
    });
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/search/starter/route';
import { API_CACHE_CONTROL } from '@/lib/api-cache';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { routeIdentityPolicy, routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { usesRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';
import { SEARCH_STARTER_EMPTY_RESPONSE, type SearchStarterResponse } from '@/lib/search-starter';
import { getSearchStarterRouteResponse, isSearchStarterDisabled } from '@/lib/search-starter-route-adapter-service';
import { getSearchStarter, type SearchStarterOptions } from '@/lib/search-starter-service';
import { proxy } from '@/proxy';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const contract = mobileApiContract.endpoints.searchStarter;
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

const requestIdBoundary = <T>(_requestId: string, callback: () => T): T => callback();
const allowedRateLimit = () => Promise.resolve({
  allowed: true,
  limit: 60,
  remaining: 59,
  retryAfterSeconds: 0,
  resetAt: '2026-11-13T12:00:00.000Z',
});

function emptyAnswer(): SearchStarterResponse {
  return { entities: [], creators: [], searches: [] };
}

function userClient(user: Record<string, unknown> | null, error: unknown = null) {
  return vi.fn(() => ({
    auth: { getUser: vi.fn(async () => ({ data: { user }, error })) },
  }) as unknown as SupabaseClient);
}

/** One request through the adapter, everything behind it a spy. */
async function ask(
  url: string,
  {
    headers,
    createUserClient = vi.fn(),
    enforceBackendRateLimit = vi.fn(allowedRateLimit),
    starter = vi.fn(async (_options: SearchStarterOptions) => emptyAnswer()),
    env = {},
  }: {
    headers?: Record<string, string>;
    /** The environment the kill switch is read from: empty unless a case throws the switch. */
    env?: Record<string, string | undefined>;
    createUserClient?: ReturnType<typeof vi.fn>;
    enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
    starter?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const logError = vi.fn();
  const response = await getSearchStarterRouteResponse({
    request: new Request(url, { headers }),
    dependencies: {
      createServiceClient: vi.fn(() => ({}) as SupabaseClient),
      createUserClient: createUserClient as never,
      enforceBackendRateLimit: enforceBackendRateLimit as never,
      getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
      getSearchStarter: starter as never,
      logError,
      withProviderFetchRequestId: requestIdBoundary,
      env,
    },
  });
  return { response, createUserClient, enforceBackendRateLimit, starter, logError };
}

const URL_ = 'http://localhost/api/search/starter';

describe('search starter route adapter', () => {
  it('answers a visitor with no token: the network’s rate limit, and an answer the edge may keep for a few minutes', async () => {
    const { response, createUserClient, enforceBackendRateLimit, starter } = await ask(URL_, {
      headers: { 'x-request-id': 'starter-1' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(emptyAnswer());
    // Every visitor gets this answer, so it is the repo's viewer-aware public read.
    expect(response.headers.get('Cache-Control')).toBe(API_CACHE_CONTROL.publicShortEdge);
    expect(response.headers.get('Cache-Control')).toBe(contract.cacheControlWithoutToken);
    // Apart from every token's answer.
    expect(response.headers.get('Vary')).toBe(contract.vary);
    expect(response.headers.get('x-request-id')).toBe('starter-1');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      ...contract.rateLimit,
      key: 'network-key',
    });
    expect(starter).toHaveBeenCalledWith({ viewerUserId: null });
  });

  it('answers a signed-in viewer privately, keyed and personalised on the verified account', async () => {
    const { response, enforceBackendRateLimit, starter } = await ask(URL_, {
      headers: { Authorization: 'Bearer token' },
      createUserClient: userClient({ id: VIEWER_ID }),
    });

    expect(response.status).toBe(200);
    // Blocks and follows are this viewer's: never stored, by anyone.
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Control')).toBe(contract.cacheControl);
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'public-search:starter',
      key: VIEWER_ID,
    }));
    expect(starter).toHaveBeenCalledWith({ viewerUserId: VIEWER_ID });
  });

  it('answers a guest’s token as it answers an account’s', async () => {
    const { response, starter } = await ask(URL_, {
      headers: { Authorization: 'Bearer guest-token' },
      createUserClient: userClient({ id: VIEWER_ID, is_anonymous: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(starter).toHaveBeenCalledWith({ viewerUserId: VIEWER_ID });
  });

  it.each([
    ['a token that names nobody', userClient(null)],
    ['a token Auth refuses', userClient(null, new Error('invalid JWT'))],
    ['a client that cannot be made', vi.fn(() => { throw new Error('no bearer'); })],
  ])('answers 401 on %s, never the visitor’s answer, which would offer whom the viewer blocked', async (_name, createUserClient) => {
    const { response, enforceBackendRateLimit, starter } = await ask(URL_, {
      headers: { Authorization: 'Bearer bad' },
      createUserClient,
    });
    expect(response.status).toBe(contract.errors.unauthenticated.status);
    await expect(response.json()).resolves.toEqual(contract.errors.unauthenticated.response);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(starter).not.toHaveBeenCalled();
  });

  it('reads no parameter: whatever a request adds, the answer is the same one', async () => {
    const { response, starter } = await ask(`${URL_}?q=portrait&limit=99&viewer=${VIEWER_ID}`);
    expect(response.status).toBe(200);
    expect(starter).toHaveBeenCalledWith({ viewerUserId: null });
  });

  describe('the kill switch', () => {
    it.each(['1', 'true', ' TRUE '])('SEARCH_STARTER_DISABLED=%j answers empty lists with no lookup of any kind', async (value) => {
      const { response, createUserClient, enforceBackendRateLimit, starter } = await ask(URL_, {
        headers: { Authorization: 'Bearer token', 'x-request-id': 'starter-off' },
        createUserClient: userClient({ id: VIEWER_ID }),
        env: { SEARCH_STARTER_DISABLED: value },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(contract.responseVariants.switchedOff.response);
      expect(SEARCH_STARTER_EMPTY_RESPONSE).toEqual(contract.responseVariants.switchedOff.response);
      // No token verified, no rate-limit row, no read.
      expect(createUserClient).not.toHaveBeenCalled();
      expect(enforceBackendRateLimit).not.toHaveBeenCalled();
      expect(starter).not.toHaveBeenCalled();
      // Never stored: the switch is felt when thrown and gone when lifted.
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.get('x-request-id')).toBe('starter-off');
    });

    it('is private for a visitor too, whose answer the edge would otherwise keep', async () => {
      const { response, starter } = await ask(URL_, { env: { SEARCH_STARTER_DISABLED: '1' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(starter).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '0', 'false', 'off'])('is off for %j: the route answers as usual', async (value) => {
      expect(isSearchStarterDisabled({ SEARCH_STARTER_DISABLED: value })).toBe(false);
      const { starter } = await ask(URL_, { env: { SEARCH_STARTER_DISABLED: value } });
      expect(starter).toHaveBeenCalledTimes(1);
    });

    it('is named in .env.example, as every name the app reads is', () => {
      expect(isSearchStarterDisabled({ SEARCH_STARTER_DISABLED: '1' })).toBe(true);
      expect(readFileSync(join(process.cwd(), '.env.example'), 'utf8')).toMatch(/^# SEARCH_STARTER_DISABLED=1$/m);
    });
  });

  it('keeps a rate-limit refusal private and retryable, and reads nothing for it', async () => {
    const { response, starter } = await ask(URL_, {
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: 60,
          remaining: 0,
          retryAfterSeconds: 17,
          resetAt: '2026-11-13T12:00:00.000Z',
        });
      }),
    });
    expect(response.status).toBe(contract.errors.rateLimited.status);
    await expect(response.json()).resolves.toMatchObject({ ...contract.errors.rateLimited.response, retryAfterSeconds: 17 });
    expect(response.headers.get('Retry-After')).toBe('17');
    // Never the edge's to keep: a stored 429 would refuse every visitor behind it.
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(starter).not.toHaveBeenCalled();
  });

  it('answers 500, privately and without the cause, when the limiter or the read fails', async () => {
    const limiter = await ask(URL_, {
      enforceBackendRateLimit: vi.fn(async () => { throw new Error('connection refused to db.internal:5432'); }),
    });
    expect(limiter.response.status).toBe(500);
    await expect(limiter.response.json()).resolves.toEqual({ error: 'Failed to check search starter request limits.' });
    expect(limiter.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(limiter.starter).not.toHaveBeenCalled();
    expect(limiter.logError).toHaveBeenCalledTimes(1);

    const read = await ask(URL_, {
      starter: vi.fn(async () => { throw new Error('search_starter returned an unexpected answer.'); }),
    });
    expect(read.response.status).toBe(500);
    await expect(read.response.json()).resolves.toEqual({ error: 'Failed to load search starter.' });
    // A failure is never the edge's to keep either.
    expect(read.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(read.logError).toHaveBeenCalledTimes(1);
  });

  it('answers the contract’s example through the real service', async () => {
    const rows = {
      entities: contract.response.entities.map((entity) => ({
        kind: entity.kind,
        key: entity.key,
        label: entity.label,
        post_count: entity.postCount,
        post_count_capped: entity.postCountCapped,
        query: entity.query,
      })),
      creators: contract.response.creators.map((creator) => ({
        id: creator.id,
        username: creator.username,
        display_name: creator.displayName,
        bio: creator.bio,
        avatar_url: creator.avatarUrl,
        public_post_count: creator.publicPostCount,
        is_following: creator.isFollowing,
      })),
      searches: contract.response.searches,
    };
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const viaService = vi.fn((options: SearchStarterOptions) => getSearchStarter(options, {
      createServiceClient: () => ({ rpc }) as unknown as SupabaseClient,
    }));

    const { response } = await ask(URL_, { starter: viaService });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(contract.response);
    expect(rpc).toHaveBeenCalledWith('search_starter', expect.objectContaining({
      p_viewer_user_id: null,
      p_entity_limit: contract.limits.maxEntities,
      p_creator_limit: contract.limits.maxCreators,
      p_search_limit: contract.limits.maxSearches,
    }));
  });

  it('writes no row to the search log: opening the screen is not a search', () => {
    for (const file of ['search-starter-route-adapter-service.ts', 'search-starter-service.ts', 'search-starter.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/lib', file), 'utf8');
      expect(source, file).not.toMatch(/public-search-query-log|recordSearchAnswer|search_query_events|\.insert\(|\.upsert\(/);
    }
  });

  it('is a thin route over the adapter', async () => {
    // The real export, switched off, so nothing behind it is needed.
    vi.stubEnv('SEARCH_STARTER_DISABLED', '1');
    try {
      const response = await GET(new Request(URL_));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(contract.responseVariants.switchedOff.response);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('search starter admission', () => {
  const SUBJECT = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'identity-admission-test-secret-at-least-32-characters');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function identityClient(options: {
    anonymous?: boolean;
    agent?: boolean;
    invalid?: boolean;
    state?: string;
    banned?: boolean;
    sessionValid?: boolean;
  } = {}) {
    const claims = {
      sub: SUBJECT,
      aud: 'authenticated',
      role: 'authenticated',
      session_id: '22222222-2222-4222-8222-222222222222',
      is_anonymous: options.anonymous ?? false,
      ...(options.agent ? { client_id: 'client-claude' } : {}),
      exp: Math.floor(Date.now() / 1000) + 3_600,
    };
    return {
      auth: {
        getClaims: vi.fn(async () => (options.invalid
          ? { data: null, error: Object.assign(new Error('invalid JWT'), { status: 401, code: 'bad_jwt', __isAuthError: true }) }
          : { data: { claims }, error: null })),
      },
      rpc: vi.fn(async () => ({
        data: {
          state: options.state ?? 'active',
          created_at: '2026-08-22T00:00:00+00:00',
          banned: options.banned ?? false,
          session_valid: options.sessionValid ?? true,
        },
        error: null,
      })),
    };
  }

  async function throughProxy(pathname: string, options: Parameters<typeof identityClient>[0] | 'no-token') {
    const request = new NextRequest(`https://magicbooklet.test${pathname}`, {
      headers: options === 'no-token' ? {} : { Authorization: 'Bearer some-token' },
    });
    const response = await proxy(request, {
      createUserClient: () => identityClient(options === 'no-token' ? {} : options) as never,
    });
    // An admitted request is passed on (no body); a refusal says why.
    const body = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() as { code?: string }
      : null;
    return { status: response.status, code: body?.code ?? null };
  }

  it('is a public route, admitted by the proxy and not by the route itself', () => {
    expect(routeIdentityPolicy('/api/search/starter')).toBe('public');
    expect(routeIdentityPolicy('/api/search/starter')).toBe(routeIdentityPolicy('/api/search'));
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(routeIdentityPolicyForRequest('/api/search/starter', method), method)
        .toBe(routeIdentityPolicyForRequest('/api/search', method));
      expect(usesRouteOwnedIdentityAdmission(
        new NextRequest('https://magicbooklet.test/api/search/starter', { method }),
      ), method).toBe(false);
    }
  });

  it.each([
    ['no token', 'no-token' as const],
    ['an account’s token', {}],
    ['a guest’s token', { anonymous: true }],
    ['an agent’s token', { agent: true }],
    ['a token that does not verify', { invalid: true }],
    ['a suspended account’s token', { banned: true }],
    ['a revoked session’s token', { sessionValid: false }],
    ['a deleting account’s token', { state: 'deleting' }],
    ['a merged guest’s token', { anonymous: true, state: 'merged' }],
  ])('is admitted exactly as /api/search is, for %s', async (_name, options) => {
    const starter = await throughProxy('/api/search/starter', options);
    const search = await throughProxy('/api/search?q=lu', options);
    expect(starter).toEqual(search);
  });

  it('admits a visitor and a guest, and refuses an agent’s token and a suspended account’s', async () => {
    expect((await throughProxy('/api/search/starter', 'no-token')).status).toBe(200);
    expect((await throughProxy('/api/search/starter', { anonymous: true })).status).toBe(200);
    expect(await throughProxy('/api/search/starter', { agent: true }))
      .toEqual({ status: 403, code: 'AGENT_TOKEN_NOT_ALLOWED' });
    expect((await throughProxy('/api/search/starter', { banned: true })).status).not.toBe(200);
    expect((await throughProxy('/api/search/starter', { invalid: true })).status).toBe(401);
  });
});

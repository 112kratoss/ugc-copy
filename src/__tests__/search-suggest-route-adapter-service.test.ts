import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/search/suggest/route';
import { API_CACHE_CONTROL } from '@/lib/api-cache';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { routeIdentityPolicy, routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { usesRouteOwnedIdentityAdmission } from '@/lib/route-owned-identity-admission';
import type { SearchSuggestResponse } from '@/lib/search-suggest';
import { getSearchSuggestRouteResponse } from '@/lib/search-suggest-route-adapter-service';
import { suggestSearch, type SearchSuggestOptions } from '@/lib/search-suggest-service';
import { proxy } from '@/proxy';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const contract = mobileApiContract.searchSuggest;
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

const requestIdBoundary = <T>(_requestId: string, callback: () => T): T => callback();
const allowedRateLimit = () => Promise.resolve({
  allowed: true,
  limit: 120,
  remaining: 119,
  retryAfterSeconds: 0,
  resetAt: '2026-11-12T12:00:00.000Z',
});

function emptyAnswer(options: SearchSuggestOptions): SearchSuggestResponse {
  return { query: options.query, normalizedQuery: options.normalizedQuery, creators: [], completions: [] };
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
    suggest = vi.fn(async (options: SearchSuggestOptions) => emptyAnswer(options)),
  }: {
    headers?: Record<string, string>;
    createUserClient?: ReturnType<typeof vi.fn>;
    enforceBackendRateLimit?: ReturnType<typeof vi.fn>;
    suggest?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const logError = vi.fn();
  const response = await getSearchSuggestRouteResponse({
    request: new Request(url, { headers }),
    dependencies: {
      createServiceClient: vi.fn(() => ({}) as SupabaseClient),
      createUserClient: createUserClient as never,
      enforceBackendRateLimit: enforceBackendRateLimit as never,
      getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
      suggestSearch: suggest as never,
      logError,
      withProviderFetchRequestId: requestIdBoundary,
    },
  });
  return { response, createUserClient, enforceBackendRateLimit, suggest, logError };
}

describe('search suggest route adapter', () => {
  it('answers a visitor with no token: the network’s rate limit, and an answer the edge may keep for a minute', async () => {
    const { response, createUserClient, enforceBackendRateLimit, suggest } = await ask(
      'http://localhost/api/search/suggest?q=%20Lu',
      { headers: { 'x-request-id': 'suggest-1' } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ query: 'Lu', normalizedQuery: 'Lu', creators: [], completions: [] });
    // Every visitor gets this answer, so it is the repo's viewer-aware public read.
    expect(response.headers.get('Cache-Control')).toBe(API_CACHE_CONTROL.publicShortEdge);
    expect(response.headers.get('Cache-Control')).toBe(contract.cacheControl.withoutToken);
    // Apart from every token's answer.
    expect(response.headers.get('Vary')).toBe(contract.vary);
    expect(response.headers.get('x-request-id')).toBe('suggest-1');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), {
      scope: 'public-search:suggest',
      limit: 120,
      windowSeconds: 60,
      key: 'network-key',
    });
    expect(suggest).toHaveBeenCalledWith({ query: 'Lu', normalizedQuery: 'Lu', handlesOnly: false, viewerUserId: null });
  });

  it('answers a signed-in viewer privately, keyed and personalised on the verified account', async () => {
    const { response, enforceBackendRateLimit, suggest } = await ask('http://localhost/api/search/suggest?q=lu', {
      headers: { Authorization: 'Bearer token' },
      createUserClient: userClient({ id: VIEWER_ID }),
    });

    expect(response.status).toBe(200);
    // Follows and blocks are this viewer's: never stored, by anyone.
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Cache-Control')).toBe(contract.cacheControl.withToken);
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'public-search:suggest',
      key: VIEWER_ID,
    }));
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: VIEWER_ID }));
  });

  it('answers a guest’s token as it answers an account’s: guests can search, so they can be offered suggestions', async () => {
    const { response, suggest } = await ask('http://localhost/api/search/suggest?q=lu', {
      headers: { Authorization: 'Bearer guest-token' },
      createUserClient: userClient({ id: VIEWER_ID, is_anonymous: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: VIEWER_ID }));
  });

  it.each([
    ['a token that names nobody', userClient(null)],
    ['a token Auth refuses', userClient(null, new Error('invalid JWT'))],
    ['a client that cannot be made', vi.fn(() => { throw new Error('no bearer'); })],
  ])('answers 401 on %s, never the visitor’s answer, which would show whom the viewer blocked', async (_name, createUserClient) => {
    const { response, enforceBackendRateLimit, suggest } = await ask('http://localhost/api/search/suggest?q=lu', {
      headers: { Authorization: 'Bearer bad' },
      createUserClient,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('reads a query typed as a handle as asking for handles', async () => {
    const { suggest } = await ask('http://localhost/api/search/suggest?q=%40Lu');
    expect(suggest).toHaveBeenCalledWith({ query: '@Lu', normalizedQuery: 'Lu', handlesOnly: true, viewerUserId: null });
  });

  it.each([
    ['http://localhost/api/search/suggest', 'q must contain at least 1 character.'],
    ['http://localhost/api/search/suggest?q=', 'q must contain at least 1 character.'],
    ['http://localhost/api/search/suggest?q=%20%20', 'q must contain at least 1 character.'],
    ['http://localhost/api/search/suggest?q=%40', 'q must contain at least 1 character.'],
    [`http://localhost/api/search/suggest?q=${'a'.repeat(101)}`, 'q must be at most 100 characters.'],
    [`http://localhost/api/search/suggest?q=${'a'.repeat(200)}`, 'q must be at most 100 characters.'],
    [`http://localhost/api/search/suggest?q=${encodeURIComponent('🔥'.repeat(101))}`, 'q must be at most 100 characters.'],
  ])('refuses %s before any lookup, privately', async (url, message) => {
    const { response, enforceBackendRateLimit, suggest, createUserClient } = await ask(url, {
      headers: { Authorization: 'Bearer token' },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
  });

  it('states its refusals as the contract does', async () => {
    const empty = await ask(`http://localhost/api/search/suggest?q=${encodeURIComponent(contract.errors.emptyQuery.query.q)}`);
    expect(empty.response.status).toBe(contract.errors.emptyQuery.status);
    await expect(empty.response.json()).resolves.toEqual(contract.errors.emptyQuery.response);
    const long = await ask(`http://localhost/api/search/suggest?q=${'a'.repeat(contract.limits.maxQueryLength + 1)}`);
    expect(long.response.status).toBe(contract.errors.queryTooLong.status);
    await expect(long.response.json()).resolves.toEqual(contract.errors.queryTooLong.response);
  });

  it.each([
    '\'', '"', '%', '%%%', '_', '\\', 'ar%', 'ar_a', '\'; drop table posts; --', 'a & b | !c', 'quil:*', '(a', '<->',
    '🔥', '🔥 po', '日本語', 'ça va', 'a'.repeat(100),
  ])('answers odd input %j with a 200 and hands it on as typed', async (typed) => {
    const { response, suggest } = await ask(`http://localhost/api/search/suggest?q=${encodeURIComponent(typed)}`);
    expect(response.status).toBe(200);
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ normalizedQuery: typed, handlesOnly: false }));
  });

  it('keeps a rate-limit refusal private and retryable, and reads nothing for it', async () => {
    const { response, suggest } = await ask('http://localhost/api/search/suggest?q=lu', {
      enforceBackendRateLimit: vi.fn(async () => {
        throw new BackendRateLimitError({
          allowed: false,
          limit: 120,
          remaining: 0,
          retryAfterSeconds: 17,
          resetAt: '2026-11-12T12:00:00.000Z',
        });
      }),
    });
    expect(response.status).toBe(contract.errors.rateLimited.status);
    await expect(response.json()).resolves.toMatchObject({ ...contract.errors.rateLimited.response, retryAfterSeconds: 17 });
    expect(response.headers.get('Retry-After')).toBe('17');
    // Never the edge's to keep: a stored 429 would refuse everyone who types the same letters.
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(suggest).not.toHaveBeenCalled();
  });

  it('answers 500, privately and without the cause, when the limiter or the read fails', async () => {
    const limiter = await ask('http://localhost/api/search/suggest?q=lu', {
      enforceBackendRateLimit: vi.fn(async () => { throw new Error('connection refused to db.internal:5432'); }),
    });
    expect(limiter.response.status).toBe(500);
    await expect(limiter.response.json()).resolves.toEqual({ error: 'Failed to check suggestion request limits.' });
    expect(limiter.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(limiter.suggest).not.toHaveBeenCalled();
    expect(limiter.logError).toHaveBeenCalledTimes(1);

    const read = await ask('http://localhost/api/search/suggest?q=lu', {
      suggest: vi.fn(async () => { throw new Error('search_suggestions returned an unexpected answer.'); }),
    });
    expect(read.response.status).toBe(500);
    await expect(read.response.json()).resolves.toEqual({ error: 'Failed to load search suggestions.' });
    // A failure is never the edge's to keep either.
    expect(read.response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(read.logError).toHaveBeenCalledTimes(1);
  });

  it('answers the contract’s examples through the real service', async () => {
    const rows = {
      creators: contract.response.creators.map((creator) => ({
        id: creator.id,
        username: creator.username,
        display_name: creator.displayName,
        avatar_url: creator.avatarUrl,
        is_following: creator.isFollowing,
      })),
      completions: contract.response.completions,
    };
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const viaService = vi.fn((options: SearchSuggestOptions) => suggestSearch(options, {
      createServiceClient: () => ({ rpc }) as unknown as SupabaseClient,
    }));

    const { response } = await ask(`http://localhost/api/search/suggest?q=${contract.query.q}`, { suggest: viaService });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(contract.response);

    // A query typed as a handle: the @ is echoed in `query`, read off in `normalizedQuery`.
    const handle = contract.responseVariants.typedAsHandle;
    rpc.mockResolvedValueOnce({
      data: {
        creators: handle.response.creators.map((creator) => ({
          id: creator.id,
          username: creator.username,
          display_name: creator.displayName,
          avatar_url: creator.avatarUrl,
          is_following: creator.isFollowing,
        })),
        completions: [],
      },
      error: null,
    });
    const typedAsHandle = await ask(`http://localhost/api/search/suggest?q=${encodeURIComponent(handle.query.q)}`, { suggest: viaService });
    await expect(typedAsHandle.response.json()).resolves.toEqual(handle.response);
    expect(rpc).toHaveBeenLastCalledWith('search_suggestions', expect.objectContaining({ p_query: 'lu', p_handles_only: true }));

    const phrase = contract.responseVariants.lastWordOfSeveral;
    rpc.mockResolvedValueOnce({ data: { creators: [], completions: phrase.response.completions }, error: null });
    const lastWord = await ask(`http://localhost/api/search/suggest?q=${encodeURIComponent(phrase.query.q)}`, { suggest: viaService });
    await expect(lastWord.response.json()).resolves.toEqual(phrase.response);
  });

  it('writes no row to the search log: a suggestion is not a search', () => {
    for (const file of ['search-suggest-route-adapter-service.ts', 'search-suggest-service.ts', 'search-suggest.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/lib', file), 'utf8');
      expect(source, file).not.toMatch(/public-search-query-log|recordSearchAnswer|search_query_events|\.insert\(|\.upsert\(/);
    }
  });

  it('is a thin route over the adapter', async () => {
    // The real export, with no bearer and no database behind it: the query is refused before either is needed.
    const response = await GET(new Request('http://localhost/api/search/suggest?q='));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'q must contain at least 1 character.' });
  });
});

describe('search suggest admission', () => {
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
    expect(routeIdentityPolicy('/api/search/suggest')).toBe('public');
    expect(routeIdentityPolicy('/api/search/suggest')).toBe(routeIdentityPolicy('/api/search'));
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(routeIdentityPolicyForRequest('/api/search/suggest', method), method)
        .toBe(routeIdentityPolicyForRequest('/api/search', method));
      expect(usesRouteOwnedIdentityAdmission(
        new NextRequest('https://magicbooklet.test/api/search/suggest?q=lu', { method }),
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
    const suggest = await throughProxy('/api/search/suggest?q=lu', options);
    const search = await throughProxy('/api/search?q=lu', options);
    expect(suggest).toEqual(search);
  });

  it('admits a visitor and a guest, and refuses an agent’s token and a suspended account’s', async () => {
    expect((await throughProxy('/api/search/suggest?q=lu', 'no-token')).status).toBe(200);
    expect((await throughProxy('/api/search/suggest?q=lu', { anonymous: true })).status).toBe(200);
    expect(await throughProxy('/api/search/suggest?q=lu', { agent: true }))
      .toEqual({ status: 403, code: 'AGENT_TOKEN_NOT_ALLOWED' });
    expect((await throughProxy('/api/search/suggest?q=lu', { banned: true })).status).not.toBe(200);
    expect((await throughProxy('/api/search/suggest?q=lu', { invalid: true })).status).toBe(401);
  });
});

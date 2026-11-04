import { describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';
import type { getShowcaseFeedPage, prepareShowcaseFeedReadAhead } from '@/lib/showcase-feed';

function createFeedPage(overrides: Record<string, unknown> = {}) {
  return {
    items: [],
    pageInfo: {
      hasMore: false,
      nextOffset: null,
      limit: 12,
      offset: 0,
    },
    ...overrides,
  };
}

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: null,
      })),
    },
  } as unknown as SupabaseClient;
}

describe('showcase feed route adapter service', () => {
  it('emits certification-only ranked-feed phase timings', async () => {
    vi.stubEnv('SCALING_CERTIFICATION_TIMINGS', '1');
    try {
      const response = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=for-you'),
        dependencies: {
          createServiceClient: vi.fn(() => ({}) as SupabaseClient),
          enforceBackendRateLimit: vi.fn(),
          getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
          resolveFeedAnonymousIdentity: vi.fn(() => ({
            anonymousKeyHash: 'anonymous-feed-hash',
            cookieValueToSet: null,
            source: 'web-cookie' as const,
          })),
          getShowcaseFeedPage: vi.fn(async (options) => {
            options.onPhaseTiming?.('candidate_rpc', 12.5);
            options.onPhaseTiming?.('persistence', 3.25);
            return createFeedPage();
          }) as unknown as typeof getShowcaseFeedPage,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Server-Timing')).toContain('candidate-rpc;dur=12.50');
      expect(response.headers.get('Server-Timing')).toContain('persistence;dur=3.25');
      expect(response.headers.get('Server-Timing')).toContain('auth;dur=');
      expect(response.headers.get('Server-Timing')).toContain('rate-limit;dur=');
      expect(response.headers.get('x-scaling-certification-timing')).toBe(
        response.headers.get('Server-Timing'),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('emits phase timings for the authenticated production performance monitor', async () => {
    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed?sort=for-you', {
        headers: {
          Authorization: 'Bearer performance-bot-token',
          'x-performance-monitor': 'load',
        },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(() => createUserClient()),
        enforceBackendRateLimit: vi.fn(),
        getShowcaseFeedPage: vi.fn(async (options) => {
          options.onPhaseTiming?.('session_page', 8.75);
          return createFeedPage();
        }) as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toContain('session-page;dur=8.75');
    expect(response.headers.get('x-scaling-certification-timing')).toBe(
      response.headers.get('Server-Timing'),
    );
  });

  it('wraps anonymous feed requests in provider request context and keeps them publicly cacheable', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
    const createUserClientDependency = vi.fn();
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed?limit=99&tool=all&offset=12&sort=recent', {
        headers: {
          'x-request-id': 'feed-adapter-anon-1',
          'x-vercel-ip-country': 'IN',
        },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'service' }) as unknown as SupabaseClient),
        createUserClient: createUserClientDependency,
        enforceBackendRateLimit: vi.fn(),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
        withProviderFetchRequestId,
      },
    });

    expect(withProviderFetchRequestId).toHaveBeenCalledWith('feed-adapter-anon-1', expect.any(Function));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('feed-adapter-anon-1');
    await expect(response.json()).resolves.toMatchObject({
      pageInfo: { limit: 12, offset: 0 },
    });
    expect(createUserClientDependency).not.toHaveBeenCalled();
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith({
      category: 'all',
      sort: 'recent',
      offset: 12,
      limit: 24,
      viewerUserId: null,
      anonymousKeyHash: null,
      cursor: null,
      requestId: 'feed-adapter-anon-1',
      tool: null,
      unlock: 'all',
      resource: 'all',
      countryCode: 'IN',
      bypassCache: false,
    });
  });

  it('uses a private session-backed response for the default anonymous For You feed', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
    const enforceBackendRateLimit = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      retryAfterSeconds: 0,
      resetAt: new Date().toISOString(),
    }));
    const response = await getShowcaseFeedRouteResponse({
      // A browser's first fetch from our pages: no feed cookie yet.
      request: new Request('http://localhost/api/showcase/feed', {
        headers: { 'x-request-id': 'feed-adapter-smart-1', 'sec-fetch-site': 'same-origin' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: vi.fn(() => 'anonymous-network-hash'),
        resolveFeedAnonymousIdentity: vi.fn(() => ({
          anonymousKeyHash: 'anonymous-feed-hash',
          cookieValueToSet: `fid_${'a'.repeat(64)}`,
          source: 'web-cookie' as const,
        })),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toContain('__Host-magicbooklet-feed-id=fid_');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'showcase-feed:for-you-read',
      key: 'anonymous-network-hash',
    }));
    expect(enforceBackendRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      getShowcaseFeedPageMock.mock.invocationCallOrder[0]
    );
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      anonymousKeyHash: 'anonymous-feed-hash',
      bypassCache: true,
      requestId: 'feed-adapter-smart-1',
      sort: 'for-you',
      viewerUserId: null,
    }));
  });

  // Usage audit (2026-11-04): a caller with no cookie and no installation id
  // that is not a browser on our pages got a fresh id per request, and with it
  // a ranked session and facts nobody came back to.
  describe('a caller with no identity at all', () => {
    function identitylessDependencies(getShowcaseFeedPageMock: ReturnType<typeof vi.fn>, cookieValueToSet: string | null) {
      return {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true, limit: 60, remaining: 59, retryAfterSeconds: 0, resetAt: new Date().toISOString(),
        })),
        getFeedNetworkKeyHash: vi.fn(() => 'anonymous-network-hash'),
        resolveFeedAnonymousIdentity: vi.fn(() => ({
          anonymousKeyHash: 'anonymous-feed-hash',
          cookieValueToSet,
          source: 'web-cookie' as const,
        })),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      };
    }

    it('is served the shared cached first page, with no identity to rank or persist for', async () => {
      const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
      const response = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?limit=12'),
        dependencies: identitylessDependencies(getShowcaseFeedPageMock, `fid_${'b'.repeat(64)}`),
      });

      expect(response.status).toBe(200);
      expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
        sort: 'for-you',
        offset: 0,
        viewerUserId: null,
        anonymousKeyHash: null,
        cursor: null,
        bypassCache: false,
      }));
      // The cookie is still offered: a client that keeps it is an
      // anonymous-cookie viewer, ranked and logged, from its next request.
      expect(response.headers.get('set-cookie')).toContain(`__Host-magicbooklet-feed-id=fid_${'b'.repeat(64)}`);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it.each(['cross-site', 'none'])('treats a %s fetch as a caller with no identity', async (site) => {
      const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
      await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed', { headers: { 'sec-fetch-site': site } }),
        dependencies: identitylessDependencies(getShowcaseFeedPageMock, `fid_${'c'.repeat(64)}`),
      });

      expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({ anonymousKeyHash: null, bypassCache: false }));
    });

    it.each(['same-origin', 'same-site'])('keeps a browser\'s first %s fetch on the ranked, logged path', async (site) => {
      const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
      await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed', { headers: { 'sec-fetch-site': site } }),
        dependencies: identitylessDependencies(getShowcaseFeedPageMock, `fid_${'d'.repeat(64)}`),
      });

      expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
        anonymousKeyHash: 'anonymous-feed-hash',
        bypassCache: true,
      }));
    });

    it('keeps an anonymous-cookie viewer on the ranked path whatever it sends', async () => {
      const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
      const response = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed'),
        dependencies: identitylessDependencies(getShowcaseFeedPageMock, null),
      });

      expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
        anonymousKeyHash: 'anonymous-feed-hash',
        bypassCache: true,
      }));
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('continues nobody\'s session: a cursor it sends finds no session of a null identity', async () => {
      const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
      await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?cursor=eyJzIjoiYSIsInAiOjEyfQ'),
        dependencies: identitylessDependencies(getShowcaseFeedPageMock, `fid_${'e'.repeat(64)}`),
      });

      expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
        anonymousKeyHash: null,
        cursor: 'eyJzIjoiYSIsInAiOjEyfQ',
        bypassCache: true,
      }));
    });
  });

  it.each(['video', 'media'])('passes the %s filter with viewer auth and disables shared caching', async (category) => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());

    const response = await getShowcaseFeedRouteResponse({
      request: new Request(`http://localhost/api/showcase/feed?category=${category}&sort=top-sales&unlock=paid&resource=prompt`, {
        headers: {
          Authorization: 'Bearer private-token',
          'x-request-id': 'feed-adapter-auth-1',
        },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'service' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        enforceBackendRateLimit: vi.fn(),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('feed-adapter-auth-1');
    expect(response.headers.has('Authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(getShowcaseFeedPageMock).toHaveBeenCalledWith(expect.objectContaining({
      anonymousKeyHash: null,
      bypassCache: false,
      category,
      resource: 'prompt',
      sort: 'top-sales',
      unlock: 'paid',
      viewerUserId: 'viewer-1',
    }));
  });

  it('returns 429 before expensive For You ranking when the read budget is exhausted', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
    const resetAt = new Date(Date.now() + 30_000).toISOString();
    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed'),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 60,
            remaining: 0,
            retryAfterSeconds: 30,
            resetAt,
          });
        }),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        resolveFeedAnonymousIdentity: vi.fn(() => ({
          anonymousKeyHash: 'anonymous-feed-hash',
          cookieValueToSet: null,
          source: 'web-cookie' as const,
        })),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getShowcaseFeedPageMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid authorization header before ranking or session writes', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());
    const enforceBackendRateLimit = vi.fn();
    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed', {
        headers: { Authorization: 'Bearer expired-token' },
      }),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient(null)),
        enforceBackendRateLimit,
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required.' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(getShowcaseFeedPageMock).not.toHaveBeenCalled();
  });

  it('sanitizes raw unlock resources before responding', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage({
      items: [{
        id: 'post-1',
        mediaUrl: 'https://example.com/image.jpg',
        mediaKind: 'image',
        model: 'nano-banana-2',
        title: 'Paid post',
        prompt: 'Public post prompt',
        body: 'Public post body',
        category: 'image',
        postFormat: 'media',
        saveCount: 0,
        remixCount: 0,
        createdAt: '2026-04-02T10:00:00.000Z',
        creator: {
          id: 'creator-1',
          username: 'creator',
          name: 'Creator',
          avatar: null,
        },
        sourceKind: 'magicbooklet',
        sourceTool: null,
        generationId: 'gen-1',
        canRemix: false,
        asset: {
          id: 'bundle-1',
          postId: 'post-1',
          title: 'Prompt pack',
          accessMode: 'paid',
          priceUsdCents: 900,
          previewText: 'Safe preview text.',
          allowRemix: false,
          resourceItems: [{
            type: 'prompt',
            title: 'Prompt',
            textContent: 'SECRET_ROUTE_PROMPT',
            externalUrl: 'https://secret.example/prompt',
            storagePath: 'creator/private/prompt.txt',
          }],
          resourceSections: [{ id: 'secret-section', title: 'Secret section' }],
        },
      }],
    }));

    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed'),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 60,
          remaining: 59,
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
        })),
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });
    const responseBody = await response.text();
    const data = JSON.parse(responseBody);

    expect(response.status).toBe(200);
    expect(data.items[0].asset).not.toHaveProperty('resourceItems');
    expect(data.items[0].asset).not.toHaveProperty('resourceSections');
    expect(responseBody).not.toContain('SECRET_ROUTE_PROMPT');
    expect(responseBody).not.toContain('https://secret.example');
    expect(responseBody).not.toContain('creator/private');
  });

  it('rate limits non-personalized sorts too, under their own generous budget', async () => {
    // top-sales scans every public post per call, so leaving the cheap-looking
    // sorts unthrottled left the most expensive read in the file wide open.
    const enforceBackendRateLimit = vi.fn();
    const serviceClient = { kind: 'service' } as unknown as SupabaseClient;

    await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed?sort=top-sales'),
      dependencies: {
        createServiceClient: vi.fn(() => serviceClient),
        createUserClient: vi.fn(() => createUserClient(null)),
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: () => 'network-hash',
        getShowcaseFeedPage: vi.fn(async () => createFeedPage()) as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(enforceBackendRateLimit).toHaveBeenCalledWith(serviceClient, {
      scope: 'showcase-feed:read',
      limit: 240,
      windowSeconds: 600,
      key: 'network-hash',
    });
  });

  it('returns 429 on an exhausted non-personalized read budget', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());

    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed?sort=top-sales'),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'service' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => createUserClient(null)),
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 240,
            remaining: 0,
            retryAfterSeconds: 42,
            resetAt: '2026-08-08T10:10:00.000Z',
          });
        }),
        getFeedNetworkKeyHash: () => 'network-hash',
        getShowcaseFeedPage: getShowcaseFeedPageMock as unknown as typeof getShowcaseFeedPage,
      },
    });

    expect(response.status).toBe(429);
    // Rejected before the catalog scan, which is the whole point.
    expect(getShowcaseFeedPageMock).not.toHaveBeenCalled();
  });

  describe("Explore's read-ahead", () => {
    const TOKEN = '0f8b6c7e-4a1d-4c2b-9e3f-5a6b7c8d9e0f';

    function readAheadDependencies({
      userId = 'user-1' as string | null,
      prepared = { token: TOKEN, expiresInMs: 120_000 } as Awaited<ReturnType<typeof prepareShowcaseFeedReadAhead>>,
    } = {}) {
      return {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(() => createUserClient(userId)),
        enforceBackendRateLimit: vi.fn(),
        getFeedNetworkKeyHash: vi.fn(() => 'network-hash'),
        resolveFeedAnonymousIdentity: vi.fn(() => ({
          anonymousKeyHash: 'anonymous-feed-hash',
          cookieValueToSet: null,
          source: 'web-cookie' as const,
        })),
        getShowcaseFeedPage: vi.fn(async () => createFeedPage()) as unknown as typeof getShowcaseFeedPage,
        prepareShowcaseFeedReadAhead: vi.fn(async () => prepared) as unknown as typeof prepareShowcaseFeedReadAhead,
      };
    }

    it('ranks a signed-in first page ahead and answers only its token, never an ordinary page', async () => {
      const dependencies = readAheadDependencies();

      const response = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=for-you&category=media&limit=12&offset=0&readAhead=1', {
          headers: { Authorization: 'Bearer user-token' },
        }),
        dependencies,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      await expect(response.json()).resolves.toEqual({ readAhead: { token: TOKEN, expiresInMs: 120_000 } });
      expect(dependencies.prepareShowcaseFeedReadAhead).toHaveBeenCalledWith({
        category: 'media',
        viewerUserId: 'user-1',
        tool: null,
        unlock: 'all',
        resource: 'all',
      });
      expect(dependencies.getShowcaseFeedPage).not.toHaveBeenCalled();
      // Counted against the ranked lane's own budget, like the read it replaces.
      expect(dependencies.enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        scope: 'showcase-feed:for-you-read',
        key: 'user-1',
      }));
    });

    it('answers null when there is nothing to hold, so the app reads the page when it is shown', async () => {
      const response = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=for-you&readAhead=1', {
          headers: { Authorization: 'Bearer user-token' },
        }),
        dependencies: readAheadDependencies({ prepared: null }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ readAhead: null });
    });

    it.each([
      ['a signed-out reader', 'sort=for-you&readAhead=1', false],
      ['an unranked lane', 'sort=recent&readAhead=1', true],
      ['a later page', 'sort=for-you&offset=12&readAhead=1', true],
      ['a continuation', 'sort=for-you&cursor=abc&readAhead=1', true],
    ])('refuses a read-ahead for %s without reading or writing a page', async (_case, query, signedIn) => {
      const dependencies = readAheadDependencies();

      const response = await getShowcaseFeedRouteResponse({
        request: new Request(`http://localhost/api/showcase/feed?${query}`, {
          headers: signedIn ? { Authorization: 'Bearer user-token' } : {},
        }),
        dependencies,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'READ_AHEAD_UNSUPPORTED' });
      expect(dependencies.getShowcaseFeedPage).not.toHaveBeenCalled();
      expect(dependencies.prepareShowcaseFeedReadAhead).not.toHaveBeenCalled();
    });

    it('hands a first page its read-ahead token, and no other read one', async () => {
      const dependencies = readAheadDependencies();
      const read = (query: string) => getShowcaseFeedRouteResponse({
        request: new Request(`http://localhost/api/showcase/feed?${query}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
        dependencies,
      });

      await read(`sort=for-you&category=media&offset=0&readAheadToken=${TOKEN}`);
      await read(`sort=for-you&offset=12&readAheadToken=${TOKEN}`);
      await read(`sort=recent&readAheadToken=${TOKEN}`);
      await read('sort=for-you&readAheadToken=not-a-token');

      const calls = vi.mocked(dependencies.getShowcaseFeedPage).mock.calls.map(([options]) => options);
      expect(calls[0]).toMatchObject({ sort: 'for-you', offset: 0, readAheadToken: TOKEN });
      expect(calls.slice(1).map((options) => 'readAheadToken' in options)).toEqual([false, false, false]);
    });

    it('answers the read-ahead, its refusal, its claim and its support flag as the shared contract pins them', async () => {
      const endpoint = mobileApiContract.endpoints.prepareShowcaseFeedReadAhead;
      const contractToken = endpoint.response.readAhead.token;
      const dependencies = readAheadDependencies({
        prepared: { token: contractToken, expiresInMs: endpoint.response.readAhead.expiresInMs },
      });
      const call = (query: Record<string, string>, signedIn = true) => getShowcaseFeedRouteResponse({
        request: new Request(`http://localhost${endpoint.path}?${new URLSearchParams(query)}`, {
          headers: signedIn ? { Authorization: 'Bearer user-token' } : {},
        }),
        dependencies,
      });

      const prepared = await call(endpoint.query);
      expect(prepared.headers.get('Cache-Control')).toBe(endpoint.cacheControl);
      await expect(prepared.json()).resolves.toEqual(endpoint.response);

      const refused = await call(endpoint.query, false);
      expect(refused.status).toBe(endpoint.errors.unsupported.status);
      await expect(refused.json()).resolves.toEqual(endpoint.errors.unsupported.response);

      const claimed = await call(endpoint.claim.query);
      expect(vi.mocked(dependencies.getShowcaseFeedPage).mock.calls.at(-1)?.[0])
        .toMatchObject({ readAheadToken: contractToken });
      await expect(claimed.json()).resolves.toMatchObject({
        [endpoint.supportedWhen.responseField]: endpoint.supportedWhen.value,
      });
    });

    it("says on a signed-in reader's For you pages that it holds read-aheads, and nowhere else", async () => {
      const signedIn = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=for-you', {
          headers: { Authorization: 'Bearer user-token' },
        }),
        dependencies: readAheadDependencies(),
      });
      const signedOut = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=for-you'),
        dependencies: readAheadDependencies(),
      });
      const recent = await getShowcaseFeedRouteResponse({
        request: new Request('http://localhost/api/showcase/feed?sort=recent', {
          headers: { Authorization: 'Bearer user-token' },
        }),
        dependencies: readAheadDependencies(),
      });

      expect(await signedIn.json()).toMatchObject({ readAheadSupported: true });
      expect(await signedOut.json()).not.toHaveProperty('readAheadSupported');
      expect(await recent.json()).not.toHaveProperty('readAheadSupported');
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { getShowcaseFeedRouteResponse } from '@/lib/showcase-feed-route-adapter-service';
import type { getShowcaseFeedPage } from '@/lib/showcase-feed';

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
    } finally {
      vi.unstubAllEnvs();
    }
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
      request: new Request('http://localhost/api/showcase/feed', {
        headers: { 'x-request-id': 'feed-adapter-smart-1' },
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

  it('uses viewer auth for personalized feed requests and disables shared caching', async () => {
    const getShowcaseFeedPageMock = vi.fn(async () => createFeedPage());

    const response = await getShowcaseFeedRouteResponse({
      request: new Request('http://localhost/api/showcase/feed?category=video&sort=top-sales&unlock=paid&resource=prompt', {
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
      category: 'video',
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
});

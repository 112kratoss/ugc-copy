import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { getPublicSearchRouteResponse } from '@/lib/public-search-route-adapter-service';
import type { PublicSearchResponse } from '@/lib/public-search';

function emptyResponse(query: string, type: PublicSearchResponse['type']): PublicSearchResponse {
  return {
    query,
    normalizedQuery: query.toLocaleLowerCase(),
    type,
    creators: { items: [], nextCursor: null },
    posts: { items: [], nextCursor: null },
    recipes: { items: [], nextCursor: null },
  };
}

const requestIdBoundary = <T>(_requestId: string, callback: () => T): T => callback();
const allowedRateLimit = () => Promise.resolve({
  allowed: true,
  limit: 180,
  remaining: 179,
  retryAfterSeconds: 0,
  resetAt: '2026-08-27T12:00:00.000Z',
});

describe('public search route adapter service', () => {
  it('serves anonymous search with private caching and a network-scoped rate limit', async () => {
    const searchPublicContent = vi.fn(async () => emptyResponse('Product reveal', 'posts'));
    const enforceBackendRateLimit = vi.fn(allowedRateLimit);
    const createUserClient = vi.fn();

    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=Product%20reveal&type=posts&limit=12', {
        headers: { 'x-request-id': 'search-1', 'x-vercel-ip-country': 'IN' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient,
        enforceBackendRateLimit,
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent,
        withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('search-1');
    expect(createUserClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      key: 'network-key',
      scope: 'public-search:read',
    }));
    expect(searchPublicContent).toHaveBeenCalledWith({
      query: 'Product reveal',
      normalizedQuery: 'Product reveal',
      type: 'posts',
      cursor: null,
      limit: 12,
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  it('uses verified optional auth for personalized filtering', async () => {
    const searchPublicContent = vi.fn(async () => emptyResponse('@luna', 'creators'));
    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=%40luna&type=creators', {
        headers: { Authorization: 'Bearer token' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        createUserClient: vi.fn(() => ({
          auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })) },
        }) as unknown as SupabaseClient),
        enforceBackendRateLimit: vi.fn(allowedRateLimit),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        searchPublicContent,
        withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(200);
    expect(searchPublicContent).toHaveBeenCalledWith(expect.objectContaining({
      query: '@luna',
      normalizedQuery: 'luna',
      viewerUserId: 'viewer-1',
    }));
  });

  it.each([
    ['http://localhost/api/search?q=a', 'q must contain at least 2 characters.'],
    ['http://localhost/api/search?q=ab&type=posts', 'posts search requires at least 3 characters.'],
    ['http://localhost/api/search?q=photo&type=unknown', 'type must be top, creators, posts, or recipes.'],
    ['http://localhost/api/search?q=photo&limit=200', 'limit must be an integer between 1 and 24.'],
  ])('rejects invalid requests before searching: %s', async (url, message) => {
    const searchPublicContent = vi.fn();
    const response = await getPublicSearchRouteResponse({
      request: new Request(url),
      dependencies: {
        searchPublicContent,
        withProviderFetchRequestId: requestIdBoundary,
      },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(searchPublicContent).not.toHaveBeenCalled();
  });

  it('keeps rate-limit responses private and retryable', async () => {
    const response = await getPublicSearchRouteResponse({
      request: new Request('http://localhost/api/search?q=portrait'),
      dependencies: {
        createServiceClient: vi.fn(() => ({}) as SupabaseClient),
        enforceBackendRateLimit: vi.fn(async () => {
          throw new BackendRateLimitError({
            allowed: false,
            limit: 180,
            remaining: 0,
            retryAfterSeconds: 9,
            resetAt: '2026-08-27T12:00:00.000Z',
          });
        }),
        getFeedNetworkKeyHash: vi.fn(() => 'network-key'),
        withProviderFetchRequestId: requestIdBoundary,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('9');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

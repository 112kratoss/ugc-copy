import { describe, expect, it, vi } from 'vitest';

import { getMarketplaceResourceDetailRouteResponse } from '@/lib/marketplace-resource-detail-route-adapter-service';

function createContext(resourceId = 'bundle-1') {
  return {
    params: Promise.resolve({ resourceId }),
  };
}

function createRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/marketplace/resources/bundle-1', {
    headers,
  });
}

function createUserClient(userId: string | null = 'viewer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: null,
      })),
    },
  };
}

describe('marketplace resource detail route adapter service', () => {
  it('serves anonymous marketplace resource detail with shared cache headers', async () => {
    const createUserClientMock = vi.fn();
    const getPostResourceBundleDetailByPostId = vi.fn(async () => ({
      id: 'bundle-1',
      postId: 'post-1',
    }));
    const withProviderFetchRequestId = vi.fn((_: string, operation: () => Promise<Response>) => operation());

    const response = await getMarketplaceResourceDetailRouteResponse({
      request: createRequest({
        'x-vercel-ip-country': 'IN',
        'x-request-id': 'resource-detail-anon-1',
      }),
      context: createContext(),
      dependencies: {
        createUserClient: createUserClientMock,
        getPostResourceBundleDetailByPostId,
        resolvePostIdForResourceIdentifier: vi.fn(async () => 'post-1'),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('resource-detail-anon-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bundle: { id: 'bundle-1' },
    });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('resource-detail-anon-1', expect.any(Function));
    expect(getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  it('uses authorized viewer context and private cache headers when Authorization is present', async () => {
    const getPostResourceBundleDetailByPostId = vi.fn(async () => ({
      id: 'bundle-1',
      postId: 'post-1',
    }));

    const response = await getMarketplaceResourceDetailRouteResponse({
      request: createRequest({
        Authorization: 'Bearer private-token',
        'x-request-id': 'resource-detail-auth-1',
      }),
      context: createContext(),
      dependencies: {
        createUserClient: () => createUserClient('viewer-1'),
        getPostResourceBundleDetailByPostId,
        resolvePostIdForResourceIdentifier: vi.fn(async () => 'post-1'),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Authorization')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('resource-detail-auth-1');
    expect(getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'viewer-1',
      countryCode: null,
    });
  });

  it('returns 404 for unknown resource identifiers before loading bundle detail', async () => {
    const getPostResourceBundleDetailByPostId = vi.fn();

    const response = await getMarketplaceResourceDetailRouteResponse({
      request: createRequest({ 'x-request-id': 'resource-detail-missing-1' }),
      context: createContext('missing'),
      dependencies: {
        getPostResourceBundleDetailByPostId,
        resolvePostIdForResourceIdentifier: vi.fn(async () => null),
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Unlock not found.' });
    expect(getPostResourceBundleDetailByPostId).not.toHaveBeenCalled();
  });
});

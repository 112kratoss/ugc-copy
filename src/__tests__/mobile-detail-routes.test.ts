import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getShowcaseFeedItemByIdMock = vi.fn();
const resolvePostIdForResourceIdentifierMock = vi.fn();
const getPostResourceBundleDetailByPostIdMock = vi.fn();
const getUserMock = vi.fn();

vi.mock('@/lib/backend-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backend-rate-limit')>()),
  // The read limiter needs a service client these tests do not build.
  enforceBackendRateLimit: vi.fn(),
}));

vi.mock('@/lib/showcase-feed', () => ({
  getShowcaseFeedItemById: (options: unknown) => getShowcaseFeedItemByIdMock(options),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  resolvePostIdForResourceIdentifier: (resourceId: string) => resolvePostIdForResourceIdentifierMock(resourceId),
  getPostResourceBundleDetailByPostId: (postId: string, options: unknown) =>
    getPostResourceBundleDetailByPostIdMock(postId, options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: () => getUserMock(),
    },
  }),
  // The detail read is rate limited now, and the limiter takes a service client.
  createServiceClient: () => ({}),
}));

describe('mobile detail API routes', () => {
  beforeEach(() => {
    vi.resetModules();
    getShowcaseFeedItemByIdMock.mockReset();
    resolvePostIdForResourceIdentifierMock.mockReset();
    getPostResourceBundleDetailByPostIdMock.mockReset();
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
      },
    });
  });

  it('returns personalized showcase post detail when authorized', async () => {
    getShowcaseFeedItemByIdMock.mockResolvedValue({
      id: 'post-1',
      title: 'Hook frame',
    });

    const { GET } = await import('@/app/api/showcase/posts/[postId]/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/posts/post-1', {
        headers: {
          Authorization: 'Bearer token',
          'x-vercel-ip-country': 'IN',
          'x-request-id': 'post-detail-auth-1',
        },
      }),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      item: {
        id: 'post-1',
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('post-detail-auth-1');
    expect(response.headers.get('Authorization')).toBeNull();
    expect(getShowcaseFeedItemByIdMock).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: 'user-1',
      countryCode: 'IN',
    });
  });

  it('marks anonymous showcase post detail as short-lived shared cacheable', async () => {
    getShowcaseFeedItemByIdMock.mockResolvedValue({
      id: 'post-1',
      title: 'Hook frame',
    });

    const { GET } = await import('@/app/api/showcase/posts/[postId]/route');
    const response = await GET(
      new NextRequest('http://localhost/api/showcase/posts/post-1', {
        headers: {
          'x-vercel-ip-country': 'IN',
          'x-request-id': 'post-detail-anon-1',
        },
      }),
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('post-detail-anon-1');
    expect(getShowcaseFeedItemByIdMock).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  it('resolves marketplace resource identifiers to bundle detail', async () => {
    resolvePostIdForResourceIdentifierMock.mockResolvedValue('post-1');
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      id: 'bundle-1',
      postId: 'post-1',
    });

    const { GET } = await import('@/app/api/marketplace/resources/[resourceId]/route');
    const response = await GET(
      new NextRequest('http://localhost/api/marketplace/resources/bundle-1', {
        headers: {
          Authorization: 'Bearer token',
          'x-request-id': 'resource-detail-auth-1',
        },
      }),
      { params: Promise.resolve({ resourceId: 'bundle-1' }) }
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      bundle: {
        id: 'bundle-1',
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('resource-detail-auth-1');
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'user-1',
      countryCode: null,
    });
  });

  it('marks anonymous marketplace resource detail as short-lived shared cacheable', async () => {
    resolvePostIdForResourceIdentifierMock.mockResolvedValue('post-1');
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      id: 'bundle-1',
      postId: 'post-1',
    });

    const { GET } = await import('@/app/api/marketplace/resources/[resourceId]/route');
    const response = await GET(
      new NextRequest('http://localhost/api/marketplace/resources/bundle-1', {
        headers: {
          'x-vercel-ip-country': 'IN',
          'x-request-id': 'resource-detail-anon-1',
        },
      }),
      { params: Promise.resolve({ resourceId: 'bundle-1' }) }
    );

    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('resource-detail-anon-1');
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', {
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  it('returns 404 for unknown marketplace resource identifiers', async () => {
    resolvePostIdForResourceIdentifierMock.mockResolvedValue(null);

    const { GET } = await import('@/app/api/marketplace/resources/[resourceId]/route');
    const response = await GET(
      new NextRequest('http://localhost/api/marketplace/resources/missing'),
      { params: Promise.resolve({ resourceId: 'missing' }) }
    );

    expect(response.status).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const getPostResourceBundleDetailByPostIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getPostResourceBundleDetailByPostId: getPostResourceBundleDetailByPostIdMock,
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  }),
}));

function getRequest(requestId: string) {
  return new Request('http://localhost/api/posts/post-1/resource-bundle', {
    headers: {
      Authorization: 'Bearer token',
      'x-request-id': requestId,
      'x-vercel-ip-country': 'IN',
    },
  }) as NextRequest;
}

describe('/api/posts/[postId]/resource-bundle route', () => {
  beforeEach(() => {
    vi.resetModules();
    getPostResourceBundleDetailByPostIdMock.mockReset();
  });

  it('serves bundle detail with viewer and country context and private headers', async () => {
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue({
      id: 'bundle-1',
      postId: 'post-1',
      accessMode: 'paid',
      resources: null,
      viewerCanAccess: false,
    });

    const { GET } = await import('@/app/api/posts/[postId]/resource-bundle/route');
    const response = await GET(getRequest('resource-bundle-get-1'), {
      params: Promise.resolve({ postId: 'post-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('resource-bundle-get-1');
    expect(data.bundle.resources).toBeNull();
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'user-1',
      countryCode: 'IN',
    });
  });

  it('returns 404 when the bundle is absent or not visible to the viewer', async () => {
    getPostResourceBundleDetailByPostIdMock.mockResolvedValue(null);

    const { GET } = await import('@/app/api/posts/[postId]/resource-bundle/route');
    const response = await GET(getRequest('resource-bundle-get-2'), {
      params: Promise.resolve({ postId: 'post-1' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Resource bundle not found.' });
  });

  it('exports no write handler', async () => {
    // The PUT surface was removed: it skipped both the media-scope validation
    // and the moderation lock that the post update path enforces.
    const routeModule = await import('@/app/api/posts/[postId]/resource-bundle/route');

    expect(Object.keys(routeModule)).toEqual(['GET']);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getShowcaseFeedItemByIdMock = vi.fn();
const resolvePostIdForResourceIdentifierMock = vi.fn();
const getPostResourceBundleDetailByPostIdMock = vi.fn();
const getUserMock = vi.fn();

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
    expect(getShowcaseFeedItemByIdMock).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: 'user-1',
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
    expect(getPostResourceBundleDetailByPostIdMock).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'user-1',
      countryCode: null,
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

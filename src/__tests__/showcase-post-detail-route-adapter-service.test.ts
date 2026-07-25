import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getShowcasePostDetailRouteResponse } from '@/lib/showcase-post-detail-route-adapter-service';
import type { getShowcaseFeedItemById } from '@/lib/showcase-feed';

function createContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

function createRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/showcase/posts/post-1', {
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
  } as unknown as SupabaseClient;
}

describe('showcase post detail route adapter service', () => {
  it('serves anonymous showcase post detail with shared cache headers', async () => {
    const createUserClientMock = vi.fn();
    const getShowcaseFeedItemByIdMock = vi.fn(async () => ({
      id: 'post-1',
      title: 'Hook frame',
    }));
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await getShowcasePostDetailRouteResponse({
      request: createRequest({
        'x-vercel-ip-country': 'IN',
        'x-request-id': 'showcase-detail-anon-1',
      }),
      context: createContext(),
      dependencies: {
        createUserClient: createUserClientMock,
        getShowcaseFeedItemById: getShowcaseFeedItemByIdMock as unknown as typeof getShowcaseFeedItemById,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(response.headers.get('Vary')).toBe('Authorization, x-vercel-ip-country');
    expect(response.headers.get('x-request-id')).toBe('showcase-detail-anon-1');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      item: { id: 'post-1' },
    });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('showcase-detail-anon-1', expect.any(Function));
    expect(getShowcaseFeedItemByIdMock).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: null,
      countryCode: 'IN',
    });
  });

  it('uses authorized viewer context and private cache headers when Authorization is present', async () => {
    const getShowcaseFeedItemByIdMock = vi.fn(async () => ({
      id: 'post-1',
      title: 'Hook frame',
    }));

    const response = await getShowcasePostDetailRouteResponse({
      request: createRequest({
        Authorization: 'Bearer private-token',
        'x-request-id': 'showcase-detail-auth-1',
      }),
      context: createContext(),
      dependencies: {
        createUserClient: vi.fn(() => createUserClient('viewer-1')),
        getShowcaseFeedItemById: getShowcaseFeedItemByIdMock as unknown as typeof getShowcaseFeedItemById,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Authorization')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('showcase-detail-auth-1');
    expect(getShowcaseFeedItemByIdMock).toHaveBeenCalledWith({
      postId: 'post-1',
      viewerUserId: 'viewer-1',
      countryCode: null,
    });
  });

  it('returns 404 when the showcase post is not public or does not exist', async () => {
    const response = await getShowcasePostDetailRouteResponse({
      request: createRequest({ 'x-request-id': 'showcase-detail-missing-1' }),
      context: createContext('missing-post'),
      dependencies: {
        getShowcaseFeedItemById: vi.fn(async () => null) as unknown as typeof getShowcaseFeedItemById,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Post not found.' });
  });

  it('logs route failures and returns a stable 500 response', async () => {
    const logError = vi.fn();

    const response = await getShowcasePostDetailRouteResponse({
      request: createRequest({ 'x-request-id': 'showcase-detail-failure-1' }),
      context: createContext(),
      dependencies: {
        getShowcaseFeedItemById: vi.fn(async () => {
          throw new Error('database unavailable');
        }) as unknown as typeof getShowcaseFeedItemById,
        logError,
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch showcase post.' });
    expect(logError).toHaveBeenCalledWith('Showcase post detail error:', expect.any(Error));
  });
});

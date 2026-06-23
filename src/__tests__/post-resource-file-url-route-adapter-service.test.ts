import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postPostResourceFileUrlRouteResponse } from '@/lib/post-resource-file-url-route-adapter-service';

function createContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

describe('post resource file-url route adapter service', () => {
  const createPostResourceFileReadUrlForRoute = vi.fn();
  const createServiceClient = vi.fn();
  const createUserClient = vi.fn();
  const userSupabase = {
    auth: {
      getUser: vi.fn(),
    },
  };

  beforeEach(() => {
    createPostResourceFileReadUrlForRoute.mockReset();
    createPostResourceFileReadUrlForRoute.mockResolvedValue({
      ok: true,
      body: {
        success: true,
        signedUrl: 'https://signed.example.com/reference.png',
      },
    });
    createServiceClient.mockReset();
    createUserClient.mockReset();
    createUserClient.mockReturnValue(userSupabase);
    userSupabase.auth.getUser.mockReset();
    userSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'buyer-1' } },
      error: null,
    });
  });

  it('delegates authenticated file-url signing with private no-store headers and lazy admin client handoff', async () => {
    const response = await postPostResourceFileUrlRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'file-url-adapter-1',
          'x-vercel-ip-country': 'IN',
        },
        body: JSON.stringify({
          storagePath: 'generation_inputs/user-1/gen-1/reference.png',
        }),
      }),
      context: createContext(),
      dependencies: {
        createPostResourceFileReadUrlForRoute,
        createServiceClient,
        createUserClient,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('file-url-adapter-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      signedUrl: 'https://signed.example.com/reference.png',
    });
    expect(createPostResourceFileReadUrlForRoute).toHaveBeenCalledWith({
      body: { storagePath: 'generation_inputs/user-1/gen-1/reference.png' },
      client: createServiceClient,
      countryCode: 'IN',
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('uses anonymous IP rate-limit keys and tolerates malformed JSON bodies', async () => {
    userSupabase.auth.getUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('missing session'),
    });

    const response = await postPostResourceFileUrlRouteResponse({
      request: new Request('http://localhost/api/posts/post-2/resource-bundle/file-url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.10, 10.0.0.1',
        },
        body: '{"storagePath":',
      }),
      context: createContext('post-2'),
      dependencies: {
        createPostResourceFileReadUrlForRoute,
        createServiceClient,
        createUserClient,
      },
    });

    expect(response.status).toBe(200);
    expect(createPostResourceFileReadUrlForRoute).toHaveBeenCalledWith({
      body: {},
      client: createServiceClient,
      countryCode: null,
      postId: 'post-2',
      rateLimitKey: '203.0.113.10',
      viewerUserId: null,
    });
  });

  it('maps service rate-limit results into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 18,
      resetAt: '2026-06-23T02:30:00.000Z',
    });
    createPostResourceFileReadUrlForRoute.mockResolvedValueOnce({
      ok: false,
      rateLimitError,
    });

    const response = await postPostResourceFileUrlRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
        method: 'POST',
        headers: { 'x-request-id': 'file-url-rate-limit-1' },
        body: JSON.stringify({ storagePath: 'reference.png' }),
      }),
      context: createContext(),
      dependencies: {
        createPostResourceFileReadUrlForRoute,
        createServiceClient,
        createUserClient,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('18');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('120');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('file-url-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 18,
    });
  });

  it('maps service validation failures without changing the response body', async () => {
    createPostResourceFileReadUrlForRoute.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: { error: 'Unlock this resource before downloading files.' },
    });

    const response = await postPostResourceFileUrlRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/file-url', {
        method: 'POST',
        body: JSON.stringify({ storagePath: 'reference.png' }),
      }),
      context: createContext(),
      dependencies: {
        createPostResourceFileReadUrlForRoute,
        createServiceClient,
        createUserClient,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Unlock this resource before downloading files.',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postPostResourceBundleOrderRouteResponse } from '@/lib/post-resource-bundle-order-route-adapter-service';

function createContext(postId = 'post-1') {
  return {
    params: Promise.resolve({ postId }),
  };
}

function createUserClient(userId: string | null = 'buyer-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('post resource bundle order route adapter service', () => {
  const createPostResourceBundleOrderForRoute = vi.fn();
  const createServiceClient = vi.fn();
  const withProviderFetchRequestId = vi.fn();
  const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;

  beforeEach(() => {
    createPostResourceBundleOrderForRoute.mockReset();
    createPostResourceBundleOrderForRoute.mockResolvedValue({
      ok: true,
      body: {
        success: true,
        orderId: 'order_bundle_123',
      },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    withProviderFetchRequestId.mockReset();
    withProviderFetchRequestId.mockImplementation((_: string, operation: () => Promise<Response>) => operation());
  });

  it('rejects unauthenticated buyers before body parsing, admin clients, or order work', async () => {
    const response = await postPostResourceBundleOrderRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'bundle-order-auth-1',
        },
        body: '{',
      }),
      context: createContext(),
      dependencies: {
        createPostResourceBundleOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('bundle-order-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createPostResourceBundleOrderForRoute).not.toHaveBeenCalled();
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('bundle-order-auth-1', expect.any(Function));
  });

  it('delegates authenticated paid bundle orders with lazy body handoff and provider trace headers', async () => {
    const request = new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'bundle-order-success-1',
        'x-vercel-ip-country': 'IN',
      },
      body: JSON.stringify({ locale: 'en-IN' }),
    });
    createPostResourceBundleOrderForRoute.mockImplementationOnce(async (input) => {
      await expect(input.readBody()).resolves.toEqual({ locale: 'en-IN' });
      return {
        ok: true,
        body: {
          success: true,
          orderId: 'order_bundle_123',
        },
      };
    });

    const response = await postPostResourceBundleOrderRouteResponse({
      request,
      context: createContext(),
      dependencies: {
        createPostResourceBundleOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('bundle-order-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      orderId: 'order_bundle_123',
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(createPostResourceBundleOrderForRoute).toHaveBeenCalledWith({
      adminSupabase,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'IN',
      readBody: expect.any(Function),
    });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('bundle-order-success-1', expect.any(Function));
  });

  it('maps paid bundle order rate limits into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 39,
      resetAt: '2026-06-23T03:00:00.000Z',
    });
    createPostResourceBundleOrderForRoute.mockResolvedValueOnce({
      ok: false,
      status: 429,
      rateLimitError,
      body: { code: 'RATE_LIMITED' },
    });

    const response = await postPostResourceBundleOrderRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'bundle-order-rate-limit-1',
        },
        body: JSON.stringify({ locale: 'en-US' }),
      }),
      context: createContext(),
      dependencies: {
        createPostResourceBundleOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('39');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 39,
      limit: 10,
    });
  });

  it('maps order validation failures without changing response bodies', async () => {
    createPostResourceBundleOrderForRoute.mockResolvedValueOnce({
      ok: false,
      status: 400,
      body: { error: 'You already own this unlock.' },
    });

    const response = await postPostResourceBundleOrderRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        body: JSON.stringify({ locale: 'en-US' }),
      }),
      context: createContext(),
      dependencies: {
        createPostResourceBundleOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'You already own this unlock.',
    });
  });
});

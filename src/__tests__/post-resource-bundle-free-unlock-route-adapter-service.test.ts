import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postResourceBundleFreeUnlockRouteResponse } from '@/lib/post-resource-bundle-free-unlock-route-adapter-service';
import type {
  PostResourceBundleFreeUnlockRouteResult,
} from '@/lib/post-resource-bundle-free-unlock-service';

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

describe('postResourceBundleFreeUnlockRouteResponse', () => {
  it('rejects unauthenticated buyers before privileged clients or unlock work', async () => {
    const createServiceClient = vi.fn();
    const unlockFreePostResourceBundleForRoute = vi.fn();

    const response = await postResourceBundleFreeUnlockRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { 'x-request-id': 'post-free-unlock-adapter-auth-1' },
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        unlockFreePostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-free-unlock-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(unlockFreePostResourceBundleForRoute).not.toHaveBeenCalled();
  });

  it('delegates successful free unlocks with buyer, post, and admin client', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const unlockFreePostResourceBundleForRoute = vi.fn(
      async (): Promise<PostResourceBundleFreeUnlockRouteResult> => ({
        ok: true,
        body: { success: true, free: true, alreadyProcessed: false },
      }),
    );

    const response = await postResourceBundleFreeUnlockRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { 'x-request-id': 'post-free-unlock-adapter-success-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        unlockFreePostResourceBundleForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-free-unlock-adapter-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      free: true,
      alreadyProcessed: false,
    });
    expect(unlockFreePostResourceBundleForRoute).toHaveBeenCalledWith({
      adminSupabase,
      buyerUserId: 'buyer-1',
      postId: 'post-1',
    });
  });

  it('maps free unlock rate limits to standard private backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 29,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postResourceBundleFreeUnlockRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { 'x-request-id': 'post-free-unlock-adapter-limit-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        unlockFreePostResourceBundleForRoute: vi.fn(async () => ({
          ok: false,
          status: 429,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('29');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-free-unlock-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 29,
      limit: 60,
    });
  });

  it('maps service validation failures with private headers', async () => {
    const response = await postResourceBundleFreeUnlockRouteResponse({
      postId: 'post-1',
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/unlock-free', {
        method: 'POST',
        headers: { 'x-request-id': 'post-free-unlock-adapter-paid-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        unlockFreePostResourceBundleForRoute: vi.fn(async () => ({
          ok: false,
          status: 400,
          body: { error: 'This bundle requires payment.' },
        })),
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('post-free-unlock-adapter-paid-1');
    await expect(response.json()).resolves.toEqual({
      error: 'This bundle requires payment.',
    });
  });
});

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError, CREDIT_UNLOCK_RATE_LIMIT } from '@/lib/backend-rate-limit';
import {
  postMarketplaceCreditUnlockRouteResponse,
  postResourceBundleCreditUnlockRouteResponse,
} from '@/lib/credit-unlock-route-adapter-service';

function createMarketplaceContext(assetId = 'asset-1') {
  return {
    params: Promise.resolve({ assetId }),
  };
}

function createPostContext(postId = 'post-1') {
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

function createRequest(url = 'http://localhost/api/marketplace/assets/asset-1/unlock-with-credits') {
  return new Request(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer private-token',
      'x-request-id': 'credit-unlock-1',
    },
  });
}

describe('credit unlock route adapter service', () => {
  it('rejects unauthenticated marketplace credit unlocks before privileged work', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const unlockMarketplaceAssetWithCredits = vi.fn();

    const response = await postMarketplaceCreditUnlockRouteResponse({
      request: createRequest(),
      context: createMarketplaceContext(),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        unlockMarketplaceAssetWithCredits,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-unlock-1');
    expect(response.headers.has('authorization')).toBe(false);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(unlockMarketplaceAssetWithCredits).not.toHaveBeenCalled();
  });

  it('maps post resource credit unlock rate limits with standard backend headers', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 20,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T08:30:00.000Z',
    });
    const enforceBackendRateLimit = vi.fn(async () => {
      throw rateLimitError;
    });
    const unlockPostResourceBundleWithCredits = vi.fn();

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit,
        unlockPostResourceBundleWithCredits,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 41,
      limit: 20,
    });
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      ...CREDIT_UNLOCK_RATE_LIMIT,
      key: 'buyer-1',
    });
    expect(unlockPostResourceBundleWithCredits).not.toHaveBeenCalled();
  });

  it('delegates successful marketplace credit unlocks after rate limiting', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const unlockMarketplaceAssetWithCredits = vi.fn(async () => ({
      success: true,
      entitlement: 'marketplace_unlock' as const,
      assetId: 'asset-1',
      credits: 18,
      alreadyProcessed: false,
    }));

    const response = await postMarketplaceCreditUnlockRouteResponse({
      request: createRequest(),
      context: createMarketplaceContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        unlockMarketplaceAssetWithCredits,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
    });
    expect(unlockMarketplaceAssetWithCredits).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      assetId: 'asset-1',
    });
  });

  it('delegates successful post resource credit unlocks after rate limiting', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const unlockPostResourceBundleWithCredits = vi.fn(async () => ({
      success: true,
      entitlement: 'post_resource_unlock' as const,
      postId: 'post-1',
      credits: 12,
      alreadyProcessed: false,
    }));

    const response = await postResourceBundleCreditUnlockRouteResponse({
      request: createRequest('http://localhost/api/posts/post-1/resource-bundle/unlock-with-credits'),
      context: createPostContext(),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 20,
          remaining: 19,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        unlockPostResourceBundleWithCredits,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
    });
    expect(unlockPostResourceBundleWithCredits).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'buyer-1',
      postId: 'post-1',
    });
  });
});

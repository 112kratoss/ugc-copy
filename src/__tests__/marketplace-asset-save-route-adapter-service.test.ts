import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postMarketplaceAssetSaveRouteResponse } from '@/lib/marketplace-asset-save-route-adapter-service';
import type { MarketplaceAssetSaveRouteResult } from '@/lib/marketplace-asset-save-service';

function createUserClient(userId: string | null = 'seller-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('marketplace asset save route adapter service', () => {
  it('rejects unauthenticated saves before service-client creation or marketplace work', async () => {
    const createServiceClient = vi.fn();
    const saveMarketplaceAssetForRoute = vi.fn();

    const response = await postMarketplaceAssetSaveRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets', {
        method: 'POST',
        headers: { 'x-request-id': 'marketplace-save-auth-1' },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        saveMarketplaceAssetForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('marketplace-save-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(saveMarketplaceAssetForRoute).not.toHaveBeenCalled();
  });

  it('passes request body reading lazily into the save service', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const userSupabase = createUserClient('seller-1');
    const body = {
      postId: 'post-1',
      type: 'guide',
      status: 'active',
      title: 'Listing',
      priceUsdCents: 100,
    };
    const saveMarketplaceAssetForRoute = vi.fn(async (params): Promise<MarketplaceAssetSaveRouteResult> => {
      await expect(params.readBody()).resolves.toEqual(body);
      return {
        ok: true,
        body: {
          success: true,
          assetId: 'asset-1',
          postId: 'post-1',
          status: 'active',
        },
      };
    });

    const response = await postMarketplaceAssetSaveRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'marketplace-save-success-1',
        },
        body: JSON.stringify(body),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => userSupabase,
        saveMarketplaceAssetForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('marketplace-save-success-1');
    await expect(response.json()).resolves.toEqual({
      success: true,
      assetId: 'asset-1',
      postId: 'post-1',
      status: 'active',
    });
    expect(saveMarketplaceAssetForRoute).toHaveBeenCalledWith({
      adminSupabase,
      readBody: expect.any(Function),
      userId: 'seller-1',
      userSupabase,
    });
  });

  it('maps service rate-limit results to standard private responses without parsing the body first', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 31,
      resetAt: '2026-06-23T10:30:00.000Z',
    });
    const saveMarketplaceAssetForRoute = vi.fn(async (): Promise<MarketplaceAssetSaveRouteResult> => ({
      ok: false,
      status: 429,
      rateLimitError,
      body: {
        error: 'Too many marketplace listing saves.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: 31,
        limit: 60,
        resetAt: '2026-06-23T10:30:00.000Z',
      },
    }));

    const response = await postMarketplaceAssetSaveRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets', {
        method: 'POST',
        headers: { 'x-request-id': 'marketplace-save-limit-1' },
        body: '{',
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('seller-1'),
        saveMarketplaceAssetForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('31');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('marketplace-save-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 31,
      limit: 60,
    });
    expect(saveMarketplaceAssetForRoute).toHaveBeenCalledWith(expect.objectContaining({
      readBody: expect.any(Function),
      userId: 'seller-1',
    }));
  });

  it('logs unexpected failures and returns a stable internal-error response', async () => {
    const logError = vi.fn();
    const saveMarketplaceAssetForRoute = vi.fn(async () => {
      throw new Error('database unavailable');
    });

    const response = await postMarketplaceAssetSaveRouteResponse({
      request: new Request('http://localhost/api/marketplace/assets', {
        method: 'POST',
        headers: { 'x-request-id': 'marketplace-save-failed-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('seller-1'),
        logError,
        saveMarketplaceAssetForRoute,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('marketplace-save-failed-1');
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith('Marketplace asset save failed:', expect.any(Error));
  });
});

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';

import { BackendRateLimitError, MOBILE_COMMERCE_RESTORE_RATE_LIMIT } from '@/lib/backend-rate-limit';
import { postMobileCommerceRestoreRouteResponse } from '@/lib/mobile-commerce-restore-route-adapter-service';

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

function createRequest(requestId = 'mobile-restore-1') {
  return new Request('http://localhost/api/mobile/commerce/restore', {
    method: 'POST',
    headers: {
      authorization: 'Bearer private-token',
      'x-request-id': requestId,
    },
  });
}

describe('mobile commerce restore route adapter service', () => {
  it('rejects unauthenticated restore requests before privileged work', async () => {
    const createServiceClient = vi.fn();
    const enforceBackendRateLimit = vi.fn();
    const restoreMobileEntitlements = vi.fn();
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await postMobileCommerceRestoreRouteResponse({
      request: createRequest('mobile-restore-auth-1'),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        enforceBackendRateLimit,
        restoreMobileEntitlements,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-restore-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('mobile-restore-auth-1', expect.any(Function));
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(restoreMobileEntitlements).not.toHaveBeenCalled();
  });

  it('maps restore rate limits with standard backend headers before RevenueCat restore work', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 6,
      remaining: 0,
      retryAfterSeconds: 88,
      resetAt: '2026-06-23T08:30:00.000Z',
    });
    const enforceBackendRateLimit = vi.fn(async () => {
      throw rateLimitError;
    });
    const restoreMobileEntitlements = vi.fn();

    const response = await postMobileCommerceRestoreRouteResponse({
      request: createRequest('mobile-restore-limit-1'),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit,
        restoreMobileEntitlements,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('88');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 88,
      limit: 6,
    });
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(adminSupabase, {
      ...MOBILE_COMMERCE_RESTORE_RATE_LIMIT,
      key: 'buyer-1',
    });
    expect(restoreMobileEntitlements).not.toHaveBeenCalled();
  });

  it('restores mobile entitlements after auth and restore throttling', async () => {
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const restoreResult = {
      success: true,
      credits: 42,
      restoredCreditPurchases: 1,
      alreadyProcessedCreditPurchases: 0,
      entitlements: [],
    };
    const restoreMobileEntitlements = vi.fn(async () => restoreResult);
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await postMobileCommerceRestoreRouteResponse({
      request: createRequest('mobile-restore-success-1'),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        enforceBackendRateLimit: vi.fn(async () => ({
          allowed: true,
          limit: 6,
          remaining: 5,
          retryAfterSeconds: 0,
          resetAt: '2026-06-23T08:30:00.000Z',
        })),
        restoreMobileEntitlements,
        withProviderFetchRequestId,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-restore-success-1');
    await expect(response.json()).resolves.toEqual(restoreResult);
    expect(withProviderFetchRequestId).toHaveBeenCalledWith('mobile-restore-success-1', expect.any(Function));
    expect(restoreMobileEntitlements).toHaveBeenCalledWith(adminSupabase, 'buyer-1');
  });
});

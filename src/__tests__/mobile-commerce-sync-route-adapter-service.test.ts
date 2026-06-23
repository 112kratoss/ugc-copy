import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postMobileCommerceSyncRouteResponse } from '@/lib/mobile-commerce-sync-route-adapter-service';
import type { MobileCommerceSyncRouteResult } from '@/lib/mobile-commerce-sync-service';

describe('mobile commerce sync route adapter service', () => {
  it('wraps provider request-id context and delegates sync inputs with private trace headers', async () => {
    const adminSupabase = { kind: 'admin' };
    const userSupabase = { kind: 'user' };
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClient = vi.fn(() => userSupabase);
    const syncMobileCommerceForRoute = vi.fn(async (): Promise<MobileCommerceSyncRouteResult> => ({
      ok: true,
      body: {
        ok: true,
        type: 'credits',
        credits: 100,
        alreadyProcessed: false,
      },
    }));
    const withProviderFetchRequestId = vi.fn((_requestId: string, operation: () => Promise<Response>) => operation());
    const request = new Request('http://localhost/api/mobile/commerce/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'mobile-commerce-sync-adapter-1',
      },
      body: JSON.stringify({ productId: 'credits-1' }),
    });

    const response = await postMobileCommerceSyncRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        syncMobileCommerceForRoute,
        withProviderFetchRequestId,
      },
    });

    expect(withProviderFetchRequestId).toHaveBeenCalledWith(
      'mobile-commerce-sync-adapter-1',
      expect.any(Function),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-commerce-sync-adapter-1');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      type: 'credits',
      credits: 100,
    });

    const serviceInput = syncMobileCommerceForRoute.mock.calls[0][0];
    expect(serviceInput.userSupabase).toBe(userSupabase);
    await expect(serviceInput.readRequestBody?.()).resolves.toEqual({ productId: 'credits-1' });
    expect(serviceInput.getAdminSupabase()).toBe(adminSupabase);
    expect(createUserClient).toHaveBeenCalledWith(request);
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('maps service rate limits with standard backend and private headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 12,
      remaining: 0,
      retryAfterSeconds: 43,
      resetAt: '2026-06-23T08:00:00.000Z',
    });

    const response = await postMobileCommerceSyncRouteResponse({
      request: new Request('http://localhost/api/mobile/commerce/sync', {
        method: 'POST',
        headers: { 'x-request-id': 'mobile-commerce-sync-limit-adapter-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(() => ({ kind: 'user' }) as never),
        syncMobileCommerceForRoute: vi.fn(async (): Promise<MobileCommerceSyncRouteResult> => ({
          ok: false,
          status: 429,
          rateLimitError,
          body: { error: 'Too many sync attempts.' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('43');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-commerce-sync-limit-adapter-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 43,
      limit: 12,
    });
  });
});

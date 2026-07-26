import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postMarketplaceVerifyRouteResponse } from '@/lib/marketplace-verify-route-adapter-service';
import type { MarketplaceVerifyRouteResult } from '@/lib/marketplace-verify-service';

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

describe('postMarketplaceVerifyRouteResponse', () => {
  it('rejects unauthenticated buyers before parsing the body or creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const verifyMarketplacePaymentForRoute = vi.fn();

    const response = await postMarketplaceVerifyRouteResponse({
      request: new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'market-verify-adapter-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        verifyMarketplacePaymentForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('market-verify-adapter-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(verifyMarketplacePaymentForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated payment verification with buyer id, admin client, secret, and lazy body reader', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const verifyMarketplacePaymentForRoute = vi.fn(
      async (): Promise<MarketplaceVerifyRouteResult> => ({
        ok: true,
        body: { success: true },
      }),
    );

    const response = await postMarketplaceVerifyRouteResponse({
      request: new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'market-verify-adapter-success-1',
        },
        body: JSON.stringify({
          razorpay_order_id: 'order_123',
          razorpay_payment_id: 'pay_123',
          razorpay_signature: 'signature',
        }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
        razorpayKeyId: 'test-key-id',
        razorpayKeySecret: 'test-secret',
        verifyMarketplacePaymentForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('market-verify-adapter-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(verifyMarketplacePaymentForRoute).toHaveBeenCalledWith({
      adminSupabase,
      buyerUserId: 'buyer-1',
      keyId: 'test-key-id',
      keySecret: 'test-secret',
      readBody: expect.any(Function),
    });
  });

  it('preserves the authorized-but-uncaptured 202 contract', async () => {
    const response = await postMarketplaceVerifyRouteResponse({
      request: new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        verifyMarketplacePaymentForRoute: vi.fn(async () => ({
          ok: true as const,
          status: 202 as const,
          body: {
            success: false,
            status: 'pending' as const,
            pending: true,
            code: 'PAYMENT_PENDING',
          },
        })),
      },
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'pending',
      pending: true,
      code: 'PAYMENT_PENDING',
    });
  });

  it('maps marketplace verify rate limits to standard private rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 29,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postMarketplaceVerifyRouteResponse({
      request: new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'market-verify-adapter-limit-1',
        },
        body: JSON.stringify({}),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        verifyMarketplacePaymentForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429 as const,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('29');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('market-verify-adapter-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 29,
      limit: 30,
    });
  });

  it('maps unexpected verification failures to stable private responses', async () => {
    const logError = vi.fn();

    const response = await postMarketplaceVerifyRouteResponse({
      request: new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: { 'x-request-id': 'market-verify-adapter-failed-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ kind: 'admin' }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
        logError,
        verifyMarketplacePaymentForRoute: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('market-verify-adapter-failed-1');
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith('Marketplace payment verification failed:', expect.any(Error));
  });
});

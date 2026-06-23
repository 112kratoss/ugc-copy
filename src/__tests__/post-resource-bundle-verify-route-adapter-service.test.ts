import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postPostResourceBundleVerifyRouteResponse } from '@/lib/post-resource-bundle-verify-route-adapter-service';

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

describe('post resource bundle verification route adapter service', () => {
  const verifyPostResourceBundlePaymentForRoute = vi.fn();
  const createServiceClient = vi.fn();
  const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;

  beforeEach(() => {
    verifyPostResourceBundlePaymentForRoute.mockReset();
    verifyPostResourceBundlePaymentForRoute.mockResolvedValue({
      ok: true,
      body: { success: true },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
  });

  it('rejects unauthenticated buyers before body parsing, admin clients, or verification work', async () => {
    const request = new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'bundle-verify-auth-1',
      },
      body: '{',
    });
    const jsonSpy = vi.spyOn(request, 'json');

    const response = await postPostResourceBundleVerifyRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient(null),
        verifyPostResourceBundlePaymentForRoute,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('bundle-verify-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(verifyPostResourceBundlePaymentForRoute).not.toHaveBeenCalled();
  });

  it('delegates authenticated paid bundle verification with lazy body handoff', async () => {
    const request = new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'bundle-verify-success-1',
      },
      body: JSON.stringify({
        razorpay_order_id: 'order_bundle_123',
        razorpay_payment_id: 'pay_bundle_123',
        razorpay_signature: 'signature',
      }),
    });
    verifyPostResourceBundlePaymentForRoute.mockImplementationOnce(async (input) => {
      await expect(input.readBody()).resolves.toEqual({
        razorpay_order_id: 'order_bundle_123',
        razorpay_payment_id: 'pay_bundle_123',
        razorpay_signature: 'signature',
      });
      return {
        ok: true,
        body: { success: true },
      };
    });

    const response = await postPostResourceBundleVerifyRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        verifyPostResourceBundlePaymentForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('bundle-verify-success-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(verifyPostResourceBundlePaymentForRoute).toHaveBeenCalledWith({
      adminSupabase,
      buyerUserId: 'buyer-1',
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      readBody: expect.any(Function),
    });
  });

  it('maps verification rate limits into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 17,
      resetAt: '2026-06-23T03:00:00.000Z',
    });
    verifyPostResourceBundlePaymentForRoute.mockResolvedValueOnce({
      ok: false,
      status: 429,
      rateLimitError,
      body: { code: 'RATE_LIMITED' },
    });

    const response = await postPostResourceBundleVerifyRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'bundle-verify-rate-limit-1',
        },
        body: JSON.stringify({}),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        verifyPostResourceBundlePaymentForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 17,
      limit: 30,
    });
  });

  it('preserves verification failure status and body', async () => {
    verifyPostResourceBundlePaymentForRoute.mockResolvedValueOnce({
      ok: false,
      status: 400,
      body: { error: 'Invalid payment signature.' },
    });

    const response = await postPostResourceBundleVerifyRouteResponse({
      request: new Request('http://localhost/api/posts/post-1/resource-bundle/verify', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
      dependencies: {
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
        verifyPostResourceBundlePaymentForRoute,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid payment signature.',
    });
  });
});

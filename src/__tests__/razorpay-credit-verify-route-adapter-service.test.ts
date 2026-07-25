import { describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postRazorpayCreditVerifyRouteResponse } from '@/lib/razorpay-credit-verify-route-adapter-service';
import type { CreditRazorpayVerifyRouteResult } from '@/lib/razorpay-credit-verify-service';

describe('razorpay credit verify route adapter service', () => {
  it('passes lazy request and Supabase factories into the verification service with private trace headers', async () => {
    const userSupabase = { kind: 'user' };
    const adminSupabase = { kind: 'admin' };
    const createUserClient = vi.fn(() => userSupabase);
    const createServiceClient = vi.fn(() => adminSupabase);
    // Typed with the real signature so `mock.calls` is a tuple of its actual
    // arguments; a bare vi.fn() infers zero parameters and calls[0][0] cannot compile.
    const verifyCreditRazorpayPaymentForRoute = vi.fn<typeof import('@/lib/razorpay-credit-verify-service').verifyCreditRazorpayPaymentForRoute>(async (): Promise<CreditRazorpayVerifyRouteResult> => ({
      ok: true,
      body: { success: true },
    }));
    const request = new Request('http://localhost/api/razorpay/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'credit-verify-adapter-1',
      },
      body: JSON.stringify({ razorpay_order_id: 'order_123' }),
    });

    const response = await postRazorpayCreditVerifyRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        getRazorpayKeySecret: () => 'test-secret',
        verifyCreditRazorpayPaymentForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-verify-adapter-1');
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(verifyCreditRazorpayPaymentForRoute).toHaveBeenCalledTimes(1);

    const serviceInput = verifyCreditRazorpayPaymentForRoute.mock.calls[0][0];
    expect(serviceInput.keySecret).toBe('test-secret');
    await expect(serviceInput.readBody()).resolves.toEqual({ razorpay_order_id: 'order_123' });
    expect(serviceInput.createUserSupabase()).toBe(userSupabase);
    expect(serviceInput.createAdminSupabase()).toBe(adminSupabase);
    expect(createUserClient).toHaveBeenCalledWith(request);
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('maps service rate-limit responses with standard rate-limit and private headers', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 42,
      resetAt: '2026-06-23T07:30:00.000Z',
    });

    const response = await postRazorpayCreditVerifyRouteResponse({
      request: new Request('http://localhost/api/razorpay/verify', {
        method: 'POST',
        headers: { 'x-request-id': 'credit-verify-rate-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(),
        verifyCreditRazorpayPaymentForRoute: vi.fn(async (): Promise<CreditRazorpayVerifyRouteResult> => ({
          ok: false,
          status: 429,
          rateLimitError,
          body: {
            error: 'Too many payment verifications.',
            code: 'RATE_LIMITED',
          },
        })),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('42');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-verify-rate-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 42,
      limit: 30,
    });
  });

  it('returns stable private failures when verification throws', async () => {
    const logError = vi.fn();
    const response = await postRazorpayCreditVerifyRouteResponse({
      request: new Request('http://localhost/api/razorpay/verify', {
        method: 'POST',
        headers: { 'x-request-id': 'credit-verify-error-1' },
      }),
      dependencies: {
        createServiceClient: vi.fn(),
        createUserClient: vi.fn(),
        logError,
        verifyCreditRazorpayPaymentForRoute: vi.fn(async () => {
          throw new Error('provider exploded');
        }),
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-verify-error-1');
    await expect(response.json()).resolves.toEqual({ error: 'provider exploded' });
    expect(logError).toHaveBeenCalledWith('Razorpay Verify Error:', expect.any(Error));
  });
});

import { describe, expect, it, vi } from 'vitest';

import { mockRequestIdPassthrough } from '@/__tests__/fixtures/request-id-passthrough';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postRazorpayCreditOrderRouteResponse } from '@/lib/razorpay-credit-order-route-adapter-service';
import type { CreditRazorpayOrderRouteResult } from '@/lib/razorpay-credit-order-service';

function createUserClient(userId: string | null = 'user-1') {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
        error: userId ? null : new Error('missing session'),
      })),
    },
  } as unknown as SupabaseClient;
}

describe('razorpay credit order route adapter service', () => {
  it('wraps provider request-id context and rejects missing plans before Supabase or provider work', async () => {
    const request = new Request('http://localhost/api/razorpay/order', {
      method: 'POST',
      headers: { 'x-request-id': 'credit-order-validation-1' },
      body: JSON.stringify({}),
    });
    const createServiceClient = vi.fn();
    const createUserClientDependency = vi.fn();
    const createCreditRazorpayOrderForRoute = vi.fn();
    const withProviderFetchRequestId = mockRequestIdPassthrough();

    const response = await postRazorpayCreditOrderRouteResponse({
      request,
      dependencies: {
        createCreditRazorpayOrderForRoute,
        createServiceClient,
        createUserClient: createUserClientDependency,
        withProviderFetchRequestId,
      },
    });

    expect(withProviderFetchRequestId).toHaveBeenCalledWith('credit-order-validation-1', expect.any(Function));
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-order-validation-1');
    await expect(response.json()).resolves.toEqual({ error: 'Missing planId' });
    expect(createUserClientDependency).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createCreditRazorpayOrderForRoute).not.toHaveBeenCalled();
  });

  it('authenticates before creating privileged clients or credit orders', async () => {
    const createServiceClient = vi.fn();
    const createCreditRazorpayOrderForRoute = vi.fn();

    const response = await postRazorpayCreditOrderRouteResponse({
      request: new Request('http://localhost/api/razorpay/order', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer private-token',
          'x-request-id': 'credit-order-auth-1',
        },
        body: JSON.stringify({ planId: 'starter' }),
      }),
      dependencies: {
        createCreditRazorpayOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-order-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized: Please log in to purchase credits.',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createCreditRazorpayOrderForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid order requests and maps rate-limit responses with private headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 48,
      resetAt: '2026-06-23T07:00:00.000Z',
    });
    const createCreditRazorpayOrderForRoute = vi.fn(async (): Promise<CreditRazorpayOrderRouteResult> => ({
      ok: false,
      status: 429,
      body: { error: 'Too many credit orders.' },
      rateLimitError,
    }));

    const response = await postRazorpayCreditOrderRouteResponse({
      request: new Request('http://localhost/api/razorpay/order', {
        method: 'POST',
        headers: { 'x-request-id': 'credit-order-limit-1' },
        body: JSON.stringify({ planId: 'starter' }),
      }),
      dependencies: {
        createCreditRazorpayOrderForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('user-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('48');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('credit-order-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 48,
      limit: 10,
    });
    expect(createCreditRazorpayOrderForRoute).toHaveBeenCalledWith({
      adminSupabase,
      userId: 'user-1',
      plan: expect.objectContaining({
        credits: 500,
        priceInr: 415,
      }),
    });
  });
});

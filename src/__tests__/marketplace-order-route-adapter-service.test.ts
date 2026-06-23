import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import { postMarketplaceOrderRouteResponse } from '@/lib/marketplace-order-route-adapter-service';
import { RazorpayOrderError } from '@/lib/razorpay-orders';

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

describe('postMarketplaceOrderRouteResponse', () => {
  it('rejects unauthenticated buyers before parsing the order body or creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const createMarketplaceOrderForRoute = vi.fn();

    const response = await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'market-order-auth-1',
        },
        body: '{',
      }),
      dependencies: {
        createMarketplaceOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient(null),
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('market-order-auth-1');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createMarketplaceOrderForRoute).not.toHaveBeenCalled();
  });

  it('rejects missing asset ids before creating an admin client', async () => {
    const createServiceClient = vi.fn();
    const createMarketplaceOrderForRoute = vi.fn();

    const response = await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: '   ' }),
      }),
      dependencies: {
        createMarketplaceOrderForRoute,
        createServiceClient,
        createUserClient: () => createUserClient('buyer-1'),
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Missing asset ID.' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(createMarketplaceOrderForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid marketplace orders with buyer id and country from Vercel headers', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createMarketplaceOrderForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true,
        orderId: 'order_market_123',
      },
    }));

    const response = await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vercel-ip-country': 'in',
        },
        body: JSON.stringify({ assetId: ' asset-1 ', locale: 'en-US' }),
      }),
      dependencies: {
        createMarketplaceOrderForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      orderId: 'order_market_123',
    });
    expect(createMarketplaceOrderForRoute).toHaveBeenCalledWith({
      adminSupabase,
      assetId: 'asset-1',
      buyerUserId: 'buyer-1',
      countryCode: 'IN',
    });
  });

  it('falls back to locale-derived country when the Vercel country header is absent', async () => {
    const adminSupabase = { kind: 'admin' } as unknown as SupabaseClient;
    const createMarketplaceOrderForRoute = vi.fn(async () => ({
      ok: true as const,
      body: { success: true },
    }));

    await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1', locale: 'en-IN' }),
      }),
      dependencies: {
        createMarketplaceOrderForRoute,
        createServiceClient: vi.fn(() => adminSupabase),
        createUserClient: () => createUserClient('buyer-1'),
      },
    });

    expect(createMarketplaceOrderForRoute).toHaveBeenCalledWith(expect.objectContaining({
      countryCode: 'IN',
    }));
  });

  it('maps marketplace order rate limits to standard backend rate-limit responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 10,
      remaining: 0,
      retryAfterSeconds: 41,
      resetAt: '2026-06-23T12:00:00.000Z',
    });

    const response = await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }),
      dependencies: {
        createMarketplaceOrderForRoute: vi.fn(async () => ({
          ok: false as const,
          status: 429,
          rateLimitError,
          body: { code: 'RATE_LIMITED' },
        })),
        createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 41,
      limit: 10,
    });
  });

  it('maps Razorpay provider errors to their stable route status', async () => {
    const response = await postMarketplaceOrderRouteResponse({
      request: new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }),
      dependencies: {
        createMarketplaceOrderForRoute: vi.fn(async () => {
          throw new RazorpayOrderError('Unable to create Razorpay order.', 502);
        }),
        createServiceClient: vi.fn(() => ({ rpc: vi.fn() }) as unknown as SupabaseClient),
        createUserClient: () => createUserClient('buyer-1'),
      },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Unable to create Razorpay order.',
    });
  });
});

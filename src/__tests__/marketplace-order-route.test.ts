import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async () => ({
  data: {
    allowed: true,
    limit: 10,
    remaining: 9,
    retryAfterSeconds: 0,
    resetAt: '2026-06-21T06:30:00.000Z',
  },
  error: null,
}));
const fromMock = vi.fn();
const orderInsertMock = vi.fn(async () => ({ error: null }));
const adminClient = { from: fromMock, rpc: rpcMock };
const createServiceClientFactory = vi.fn(() => adminClient);
const getMarketplacePriceQuoteMock = vi.fn();
const providerFetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'order_market_123' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}));

let assetRows: Array<{
  id: string;
  title: string;
  price_usd_cents: number;
  status: 'draft' | 'active' | 'unlisted' | 'deleted';
  seller_user_id: string;
}> = [];
let purchaseRows: Array<{ asset_id: string; buyer_user_id: string }> = [];

function createQuery<T extends Record<string, unknown>>(rows: T[]) {
  const filters: Record<string, unknown> = {};
  const query = {
    select() {
      return query;
    },
    eq(column: string, value: unknown) {
      filters[column] = value;
      return query;
    },
    async maybeSingle() {
      return {
        data: rows.find((row) =>
          Object.entries(filters).every(([key, value]) => row[key] === value)
        ) ?? null,
        error: null,
      };
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/marketplace-server', () => ({
  getMarketplacePriceQuote: (...args: unknown[]) => getMarketplacePriceQuoteMock(...args),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/marketplace/order route', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetModules();
    assetRows = [{
      id: 'asset-1',
      title: 'Prompt Pack',
      price_usd_cents: 500,
      status: 'active',
      seller_user_id: 'seller-1',
    }];
    purchaseRows = [];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({
      data: {
        allowed: true,
        limit: 10,
        remaining: 9,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === 'marketplace_assets') return createQuery(assetRows);
      if (table === 'marketplace_purchases') return createQuery(purchaseRows);
      if (table === 'marketplace_orders') {
        return {
          insert: orderInsertMock,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    orderInsertMock.mockClear();
    orderInsertMock.mockResolvedValue({ error: null });
    getMarketplacePriceQuoteMock.mockClear();
    getMarketplacePriceQuoteMock.mockResolvedValue({
      amountSubunits: 41500,
      currency: 'INR',
      formatted: '₹415',
      note: null,
    });
    providerFetchMock.mockClear();
    providerFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'order_market_123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'razorpay-secret';
    vi.stubGlobal('fetch', providerFetchMock);
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });
  });

  it('does not create an admin client before authentication succeeds', async () => {
    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: 'Bearer private-token',
          'x-request-id': 'market-order-auth-1',
        },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'market-order-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
    expect(providerFetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing asset IDs before creating an admin client', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: '' }),
      }) as never
    );

    expect(response.status).toBe(400);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
    expect(providerFetchMock).not.toHaveBeenCalled();
  });

  it('rate limits marketplace order creation before listing lookup or payment work', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    rpcMock.mockResolvedValue({
      data: {
        allowed: false,
        limit: 10,
        remaining: 0,
        retryAfterSeconds: 41,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'market-order-rate-limit-1',
        },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expectPrivateNoStoreTraceHeaders(response, 'market-order-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(fromMock).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
    expect(providerFetchMock).not.toHaveBeenCalled();
    expect(orderInsertMock).not.toHaveBeenCalled();
  });

  it('creates paid marketplace orders after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vercel-ip-country': 'IN',
          'x-request-id': 'market-order-success-1',
        },
        body: JSON.stringify({ assetId: 'asset-1', locale: 'en-IN' }),
      }) as never
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'market-order-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getMarketplacePriceQuoteMock).toHaveBeenCalledWith(500, 'IN');
    expect(providerFetchMock).toHaveBeenCalledWith('https://api.razorpay.com/v1/orders', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"amount":41500'),
      signal: expect.any(AbortSignal),
    }));
    expect(orderInsertMock).toHaveBeenCalledWith({
      asset_id: 'asset-1',
      buyer_user_id: 'buyer-1',
      razorpay_order_id: 'order_market_123',
      amount_subunits: 41500,
      currency: 'INR',
      status: 'created',
    });
  });

  it('returns 504 when Razorpay order creation times out before recording a marketplace order', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    providerFetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));

    const { POST } = await import('@/app/api/marketplace/order/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vercel-ip-country': 'IN',
        },
        body: JSON.stringify({ assetId: 'asset-1', locale: 'en-IN' }),
      }) as never
    );

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: 'Payment provider timed out. Please try again.',
    });
    expect(providerFetchMock).toHaveBeenCalledOnce();
    expect(orderInsertMock).not.toHaveBeenCalled();
    // Reported through the route adapter's injectable logError seam, which
    // routes into the structured logger under a shared event name.
    const orderLog = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(orderLog.msg).toBe('route_adapter_error');
    expect(orderLog.message).toBe('Marketplace order creation failed:');
    expect(orderLog.errorName).toBe('ExternalServiceTimeoutError');
  });
});

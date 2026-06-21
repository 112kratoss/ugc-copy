import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const razorpayOrdersCreateMock = vi.fn(async () => ({ id: 'order_market_123' }));
const RazorpayMock = vi.fn(function RazorpayMock(this: { orders: { create: typeof razorpayOrdersCreateMock } }) {
  this.orders = {
    create: razorpayOrdersCreateMock,
  };
});

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

vi.mock('razorpay', () => ({
  default: RazorpayMock,
}));

describe('/api/marketplace/order route', () => {
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
    RazorpayMock.mockClear();
    razorpayOrdersCreateMock.mockClear();
    razorpayOrdersCreateMock.mockResolvedValue({ id: 'order_market_123' });
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: 'asset-1' }),
      }) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(fromMock).not.toHaveBeenCalled();
    expect(getMarketplacePriceQuoteMock).not.toHaveBeenCalled();
    expect(RazorpayMock).not.toHaveBeenCalled();
    expect(razorpayOrdersCreateMock).not.toHaveBeenCalled();
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
        },
        body: JSON.stringify({ assetId: 'asset-1', locale: 'en-IN' }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getMarketplacePriceQuoteMock).toHaveBeenCalledWith(500, 'IN');
    expect(razorpayOrdersCreateMock).toHaveBeenCalledWith({
      amount: 41500,
      currency: 'INR',
      receipt: expect.stringMatching(/^mkt_buyer-1_\d+$/),
      notes: {
        asset_id: 'asset-1',
        buyer_user_id: 'buyer-1',
      },
    });
    expect(orderInsertMock).toHaveBeenCalledWith({
      asset_id: 'asset-1',
      buyer_user_id: 'buyer-1',
      razorpay_order_id: 'order_market_123',
      amount_subunits: 41500,
      currency: 'INR',
      status: 'created',
    });
  });
});

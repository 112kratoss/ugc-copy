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
const getBundleForOrderByPostIdMock = vi.fn();
const getPostResourceBundlePriceQuoteMock = vi.fn();
const razorpayOrdersCreateMock = vi.fn(async () => ({ id: 'order_bundle_123' }));
const RazorpayMock = vi.fn(function RazorpayMock(this: { orders: { create: typeof razorpayOrdersCreateMock } }) {
  this.orders = {
    create: razorpayOrdersCreateMock,
  };
});

let purchaseRows: Array<{ bundle_id: string; buyer_user_id: string }> = [];

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

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getBundleForOrderByPostId: (...args: unknown[]) => getBundleForOrderByPostIdMock(...args),
  getPostResourceBundlePriceQuote: (...args: unknown[]) => getPostResourceBundlePriceQuoteMock(...args),
}));

vi.mock('razorpay', () => ({
  default: RazorpayMock,
}));

describe('/api/posts/[postId]/resource-bundle/order route', () => {
  beforeEach(() => {
    vi.resetModules();
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
      if (table === 'post_resource_bundle_purchases') return createQuery(purchaseRows);
      if (table === 'post_resource_bundle_orders') {
        return {
          insert: orderInsertMock,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    orderInsertMock.mockClear();
    orderInsertMock.mockResolvedValue({ error: null });
    getBundleForOrderByPostIdMock.mockClear();
    getBundleForOrderByPostIdMock.mockResolvedValue({
      id: 'bundle-1',
      post_id: 'post-1',
      owner_user_id: 'owner-1',
      access_mode: 'paid',
      status: 'published',
      title: 'Launch Hook Pack',
      price_usd_cents: 700,
    });
    getPostResourceBundlePriceQuoteMock.mockClear();
    getPostResourceBundlePriceQuoteMock.mockResolvedValue({
      amountSubunits: 58100,
      currency: 'INR',
      formatted: 'INR 581',
      note: null,
    });
    RazorpayMock.mockClear();
    razorpayOrdersCreateMock.mockClear();
    razorpayOrdersCreateMock.mockResolvedValue({ id: 'order_bundle_123' });
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
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'en-US' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuoteMock).not.toHaveBeenCalled();
  });

  it('rate limits paid resource bundle orders before bundle lookup or payment work', async () => {
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
        retryAfterSeconds: 39,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'en-IN' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('39');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuoteMock).not.toHaveBeenCalled();
    expect(RazorpayMock).not.toHaveBeenCalled();
    expect(razorpayOrdersCreateMock).not.toHaveBeenCalled();
    expect(orderInsertMock).not.toHaveBeenCalled();
  });

  it('creates paid resource bundle orders after passing the backend rate limit', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vercel-ip-country': 'IN',
        },
        body: JSON.stringify({ locale: 'en-IN' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getBundleForOrderByPostIdMock).toHaveBeenCalledWith('post-1');
    expect(getPostResourceBundlePriceQuoteMock).toHaveBeenCalledWith(700, 'IN');
    expect(razorpayOrdersCreateMock).toHaveBeenCalledWith({
      amount: 58100,
      currency: 'INR',
      receipt: expect.stringMatching(/^bundle_buyer-1_\d+$/),
      notes: {
        bundle_id: 'bundle-1',
        buyer_user_id: 'buyer-1',
        post_id: 'post-1',
      },
    });
    expect(orderInsertMock).toHaveBeenCalledWith({
      bundle_id: 'bundle-1',
      buyer_user_id: 'buyer-1',
      razorpay_order_id: 'order_bundle_123',
      amount_subunits: 58100,
      currency: 'INR',
      status: 'created',
    });
  });
});

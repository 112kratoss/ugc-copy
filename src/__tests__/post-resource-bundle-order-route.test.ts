import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createUserClientMock = vi.fn();
const rpcMock = vi.fn(async (
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> => {
  void name;
  void args;
  return {
    data: {
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfterSeconds: 0,
      resetAt: '2026-06-21T06:30:00.000Z',
    },
    error: null,
  };
});
const fromMock = vi.fn();
const adminClient = { from: fromMock, rpc: rpcMock };
const createServiceClientFactory = vi.fn(() => adminClient);
const getBundleForOrderByPostIdMock = vi.fn();
const getPostResourceBundlePriceQuoteMock = vi.fn();
const providerFetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'order_bundle_123' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
}));

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

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getBundleForOrderByPostId: (...args: unknown[]) => getBundleForOrderByPostIdMock(...args),
  getPostResourceBundlePriceQuote: (...args: unknown[]) => getPostResourceBundlePriceQuoteMock(...args),
}));

describe('/api/posts/[postId]/resource-bundle/order route', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetModules();
    purchaseRows = [];
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'claim_razorpay_checkout_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '30000000-0000-4000-8000-000000000003',
            provider_receipt: 'mb_30000000000040008000000000000003',
            provider_order_id: null,
          },
          error: null,
        };
      }
      if (name === 'get_post_resource_bundle_cash_quote') {
        return {
          data: {
            status: 'quoted',
            bundle_id: 'bundle-1',
            post_id: 'post-1',
            owner_user_id: 'owner-1',
            title: 'Launch Hook Pack',
            price_usd_cents: 700,
            revision_id: 'revision-1',
            content_fingerprint: 'fingerprint-1',
          },
          error: null,
        };
      }
      if (name === 'complete_razorpay_checkout_intent') {
        return {
          data: { status: 'recorded', provider_order_id: args.p_provider_order_id },
          error: null,
        };
      }
      if (name === 'abandon_razorpay_checkout_intent') {
        return { data: { status: 'abandoned' }, error: null };
      }
      if (name === 'record_post_resource_bundle_cash_order') {
        return { data: { status: 'created', order_id: 'local-order-1' }, error: null };
      }
      return {
        data: {
          allowed: true,
          limit: 10,
          remaining: 9,
          retryAfterSeconds: 0,
          resetAt: '2026-06-21T06:30:00.000Z',
        },
        error: null,
      };
    });
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === 'post_resource_bundle_purchases') return createQuery(purchaseRows);
      throw new Error(`Unexpected table: ${table}`);
    });
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
    providerFetchMock.mockClear();
    providerFetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'order_bundle_123' }), {
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
    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer private-token',
          'x-request-id': 'bundle-order-auth-1',
        },
        body: JSON.stringify({ locale: 'en-US' }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'bundle-order-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuoteMock).not.toHaveBeenCalled();
    expect(providerFetchMock).not.toHaveBeenCalled();
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
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'bundle-order-rate-limit-1',
        },
        body: JSON.stringify({
          locale: 'en-IN',
          clientIntentKey: 'intent-bundle-route-123456',
        }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('39');
    expectPrivateNoStoreTraceHeaders(response, 'bundle-order-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getBundleForOrderByPostIdMock).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuoteMock).not.toHaveBeenCalled();
    expect(providerFetchMock).not.toHaveBeenCalled();
    expect(rpcMock.mock.calls.map(([name]) => name)).not.toContain('record_post_resource_bundle_cash_order');
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
          'x-request-id': 'bundle-order-success-1',
        },
        body: JSON.stringify({
          locale: 'en-IN',
          clientIntentKey: 'intent-bundle-timeout-123456',
        }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'bundle-order-success-1');
    expect(rpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'post-resource-order:create',
      p_subject_key: 'buyer-1',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(getBundleForOrderByPostIdMock).toHaveBeenCalledWith('post-1');
    expect(getPostResourceBundlePriceQuoteMock).toHaveBeenCalledWith(700, 'IN');
    expect(providerFetchMock).toHaveBeenCalledWith('https://api.razorpay.com/v1/orders', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"amount":58100'),
      signal: expect.any(AbortSignal),
    }));
    expect(rpcMock).toHaveBeenCalledWith('record_post_resource_bundle_cash_order', {
      p_post_id: 'post-1',
      p_bundle_id: 'bundle-1',
      p_buyer_user_id: 'buyer-1',
      p_razorpay_order_id: 'order_bundle_123',
      p_amount_subunits: 58100,
      p_currency: 'INR',
      p_expected_price_usd_cents: 700,
      p_expected_revision_id: 'revision-1',
      p_expected_content_fingerprint: 'fingerprint-1',
    });
  });

  it('returns 504 when Razorpay order creation times out before recording a bundle order', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'buyer-1' } },
          error: null,
        })),
      },
    });
    providerFetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));

    const { POST } = await import('@/app/api/posts/[postId]/resource-bundle/order/route');
    const response = await POST(
      new Request('http://localhost/api/posts/post-1/resource-bundle/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vercel-ip-country': 'IN',
          'x-request-id': 'bundle-order-timeout-1',
        },
        body: JSON.stringify({
          locale: 'en-IN',
          clientIntentKey: 'intent-bundle-timeout-123456',
        }),
      }) as never,
      { params: Promise.resolve({ postId: 'post-1' }) }
    );

    expect(response.status).toBe(504);
    expectPrivateNoStoreTraceHeaders(response, 'bundle-order-timeout-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Payment provider timed out. Please try again.',
    });
    expect(providerFetchMock).toHaveBeenCalledTimes(2);
    expect(rpcMock.mock.calls.map(([name]) => name)).not.toContain('record_post_resource_bundle_cash_order');
  });
});

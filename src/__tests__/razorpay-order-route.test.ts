import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type UserResult = {
    data: {
      user: { id: string } | null;
    };
    error: Error | null;
  };

  const providerFetch = vi.fn(async () => new Response(JSON.stringify({ id: 'order_123' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));

  const userGetUser = vi.fn(async (): Promise<UserResult> => ({
    data: { user: null },
    error: new Error('missing session'),
  }));
  const createUserClient = vi.fn((_request: Request) => {
    void _request;

    return {
      auth: {
        getUser: userGetUser,
      },
    };
  });

  const rawGetUser = vi.fn(async (): Promise<UserResult> => ({
    data: { user: null },
    error: new Error('raw client should not be used'),
  }));
  const createClient = vi.fn((_url: string, _key: string, _options?: unknown) => {
    void _url;
    void _key;
    void _options;

    return {
      auth: {
        getUser: rawGetUser,
      },
    };
  });

  const single = vi.fn(async () => ({ data: { id: 'txn_123' }, error: null }));
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  const rpc = vi.fn(async (
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
  const createServiceClient = vi.fn(() => ({ from, rpc }));

  return {
    createClient,
    createServiceClient,
    createUserClient,
    providerFetch,
    from,
    insert,
    rawGetUser,
    rpc,
    select,
    single,
    userGetUser,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options?: unknown) => mocks.createClient(url, key, options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
  createUserClient: (request: Request) => mocks.createUserClient(request),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function buildOrderRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/razorpay/order', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user-token',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('/api/razorpay/order route', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
    mocks.createServiceClient.mockClear();
    mocks.createUserClient.mockClear();
    mocks.from.mockClear();
    mocks.insert.mockClear();
    mocks.providerFetch.mockClear();
    mocks.providerFetch.mockResolvedValue(new Response(JSON.stringify({ id: 'order_123' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    mocks.rawGetUser.mockClear();
    mocks.rpc.mockClear();
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'claim_razorpay_checkout_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '10000000-0000-4000-8000-000000000001',
            provider_receipt: 'mb_10000000000040008000000000000001',
            provider_order_id: null,
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
    mocks.select.mockClear();
    mocks.single.mockClear();
    mocks.userGetUser.mockReset();
    mocks.userGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error('missing session'),
    });
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'razorpay-secret';
    vi.stubGlobal('fetch', mocks.providerFetch);
  });

  it('rejects missing plan IDs before creating Razorpay or Supabase clients', async () => {
    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({}, {
      'x-request-id': 'credit-order-validation-1',
    }));

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'credit-order-validation-1');
    expect(await response.json()).toEqual({ error: 'Missing planId' });
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createUserClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('authenticates through the shared user client before creating Razorpay orders', async () => {
    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({
      planId: 'starter',
      clientIntentKey: 'intent-credit-route-123456',
    }, {
      Authorization: 'Bearer private-token',
      'x-request-id': 'credit-order-auth-1',
    }));

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'credit-order-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to purchase credits.',
    });
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('creates orders and transaction records after validation and authentication', async () => {
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123456789' } },
      error: null,
    });

    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({
      planId: 'starter',
      clientIntentKey: 'intent-credit-timeout-123456',
    }, {
      'x-request-id': 'credit-order-success-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'credit-order-success-1');
    expect(await response.json()).toEqual({
      amount: 41500,
      currency: 'INR',
      orderId: 'order_123',
    });
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-order:create',
      p_subject_key: 'user_123456789',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(mocks.providerFetch).toHaveBeenCalledWith('https://api.razorpay.com/v1/orders', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from('rzp_test_key:razorpay-secret').toString('base64')}`,
        'Content-Type': 'application/json',
      }),
      body: expect.stringMatching(/"amount":41500/),
      signal: expect.any(AbortSignal),
    }));
    // Called at least once for the route's own work. Not an exact count:
    // the provider-fetch attempt counter builds its own memoized service
    // client on the first provider call a test file makes, so an exact
    // count here would depend on test order within the file.
    expect(mocks.createServiceClient).toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith('transactions');
    expect(mocks.insert).toHaveBeenCalledWith({
      amount: 41500,
      credits: 500,
      currency: 'INR',
      razorpay_order_id: 'order_123',
      status: 'created',
      user_id: 'user_123456789',
    });
  });

  it('rate limits authenticated credit order creation before Razorpay or transaction work', async () => {
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123456789' } },
      error: null,
    });
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: false,
        limit: 10,
        remaining: 0,
        retryAfterSeconds: 48,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });

    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({ planId: 'starter' }, {
      'x-request-id': 'credit-order-rate-limit-1',
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('48');
    expectPrivateNoStoreTraceHeaders(response, 'credit-order-rate-limit-1');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-order:create',
      p_subject_key: 'user_123456789',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('returns 504 when Razorpay order creation times out before recording a transaction', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123456789' } },
      error: null,
    });
    mocks.providerFetch.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));

    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({
      planId: 'starter',
      clientIntentKey: 'intent-credit-timeout-123456',
    }, {
      'x-request-id': 'credit-order-timeout-1',
    }));

    expect(response.status).toBe(504);
    expectPrivateNoStoreTraceHeaders(response, 'credit-order-timeout-1');
    await expect(response.json()).resolves.toEqual({
      error: 'Payment provider timed out. Please try again.',
    });
    expect(mocks.providerFetch).toHaveBeenCalledTimes(2);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    // Now reported through the structured logger, which also carries the
    // ambient request id.
    const orderLog = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(orderLog.msg).toBe('razorpay_order_error');
    expect(orderLog.errorName).toBe('ExternalServiceTimeoutError');
  });
});

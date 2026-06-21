import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type UserResult = {
    data: {
      user: { id: string } | null;
    };
    error: Error | null;
  };

  const ordersCreate = vi.fn(async () => ({ id: 'order_123' }));
  const Razorpay = vi.fn(function RazorpayMock(this: { orders: { create: typeof ordersCreate } }) {
    this.orders = {
      create: ordersCreate,
    };
  });

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
  const rpc = vi.fn(async () => ({
    data: {
      allowed: true,
      limit: 10,
      remaining: 9,
      retryAfterSeconds: 0,
      resetAt: '2026-06-21T06:30:00.000Z',
    },
    error: null,
  }));
  const createServiceClient = vi.fn(() => ({ from, rpc }));

  return {
    createClient,
    createServiceClient,
    createUserClient,
    from,
    insert,
    ordersCreate,
    rawGetUser,
    rpc,
    Razorpay,
    select,
    single,
    userGetUser,
  };
});

vi.mock('razorpay', () => ({
  default: mocks.Razorpay,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options?: unknown) => mocks.createClient(url, key, options),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => mocks.createServiceClient(),
  createUserClient: (request: Request) => mocks.createUserClient(request),
}));

function buildOrderRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/razorpay/order', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/razorpay/order route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
    mocks.createServiceClient.mockClear();
    mocks.createUserClient.mockClear();
    mocks.from.mockClear();
    mocks.insert.mockClear();
    mocks.ordersCreate.mockClear();
    mocks.rawGetUser.mockClear();
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({
      data: {
        allowed: true,
        limit: 10,
        remaining: 9,
        retryAfterSeconds: 0,
        resetAt: '2026-06-21T06:30:00.000Z',
      },
      error: null,
    });
    mocks.Razorpay.mockClear();
    mocks.select.mockClear();
    mocks.single.mockClear();
    mocks.userGetUser.mockReset();
    mocks.userGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error('missing session'),
    });
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'razorpay-secret';
  });

  it('rejects missing plan IDs before creating Razorpay or Supabase clients', async () => {
    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing planId' });
    expect(mocks.Razorpay).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createUserClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('authenticates through the shared user client before creating Razorpay orders', async () => {
    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({ planId: 'starter' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Unauthorized: Please log in to purchase credits.',
    });
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.Razorpay).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('creates orders and transaction records after validation and authentication', async () => {
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123456789' } },
      error: null,
    });

    const { POST } = await import('@/app/api/razorpay/order/route');
    const response = await POST(buildOrderRequest({ planId: 'starter' }));

    expect(response.status).toBe(200);
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
    expect(mocks.Razorpay).toHaveBeenCalledTimes(1);
    expect(mocks.ordersCreate).toHaveBeenCalledWith({
      amount: 41500,
      currency: 'INR',
      receipt: expect.stringMatching(/^rcpt_user_123_\d+$/),
    });
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('transactions');
    expect(mocks.insert).toHaveBeenCalledWith({
      amount: 41500,
      credits: 500,
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
    const response = await POST(buildOrderRequest({ planId: 'starter' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('48');
    await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-order:create',
      p_subject_key: 'user_123456789',
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(mocks.Razorpay).not.toHaveBeenCalled();
    expect(mocks.ordersCreate).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type UserResult = {
    data: {
      user: { id: string } | null;
    };
    error: Error | null;
  };

  const userGetUser = vi.fn(async (): Promise<UserResult> => ({
    data: { user: null },
    error: new Error('missing session'),
  }));

  const single = vi.fn(async () => ({
    data: {
      id: 'txn_123',
      credits: 500,
      status: 'created',
    },
    error: null,
  }));
  const secondEq = vi.fn(() => ({ single }));
  const firstEq = vi.fn(() => ({ eq: secondEq }));
  const select = vi.fn(() => ({ eq: firstEq }));
  const from = vi.fn(() => ({ select }));

  const createUserClient = vi.fn((_request: Request) => {
    void _request;

    return {
      auth: {
        getUser: userGetUser,
      },
      from,
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
      from,
    };
  });

  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const createServiceClient = vi.fn(() => ({ rpc }));

  return {
    createClient,
    createServiceClient,
    createUserClient,
    firstEq,
    from,
    rawGetUser,
    rpc,
    secondEq,
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

function buildSignedPayload(overrides: Record<string, unknown> = {}) {
  const payload = {
    razorpay_order_id: 'order_123',
    razorpay_payment_id: 'pay_123',
    userId: 'user_123',
    ...overrides,
  };
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
    .update(`${payload.razorpay_order_id}|${payload.razorpay_payment_id}`)
    .digest('hex');

  return {
    ...payload,
    razorpay_signature: signature,
  };
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function buildVerifyRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/razorpay/verify', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer user-token',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('/api/razorpay/verify route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockClear();
    mocks.createServiceClient.mockClear();
    mocks.createUserClient.mockClear();
    mocks.firstEq.mockClear();
    mocks.from.mockClear();
    mocks.rawGetUser.mockClear();
    mocks.rpc.mockClear();
    mocks.secondEq.mockClear();
    mocks.select.mockClear();
    mocks.single.mockClear();
    mocks.userGetUser.mockReset();
    mocks.userGetUser.mockResolvedValue({
      data: { user: null },
      error: new Error('missing session'),
    });
    mocks.single.mockResolvedValue({
      data: {
        id: 'txn_123',
        credits: 500,
        status: 'created',
      },
      error: null,
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: true,
            limit: 30,
            remaining: 29,
            retryAfterSeconds: 0,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        };
      }

      return { data: true, error: null };
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.RAZORPAY_KEY_SECRET = 'razorpay-secret';
  });

  it('rejects malformed payloads before creating Supabase clients', async () => {
    const { POST } = await import('@/app/api/razorpay/verify/route');
    const response = await POST(buildVerifyRequest({}, {
      'x-request-id': 'credit-verify-validation-1',
    }));

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'credit-verify-validation-1');
    expect(await response.json()).toEqual({ error: 'Missing required parameters' });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createUserClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('uses the shared user client and does not create an admin client when authentication fails', async () => {
    const { POST } = await import('@/app/api/razorpay/verify/route');
    const response = await POST(buildVerifyRequest(buildSignedPayload(), {
      Authorization: 'Bearer private-token',
      'x-request-id': 'credit-verify-auth-1',
    }));

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'credit-verify-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it('rate limits verified credit payments before transaction lookup or credit mutation', async () => {
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123' } },
      error: null,
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: false,
            limit: 30,
            remaining: 0,
            retryAfterSeconds: 41,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        };
      }

      return { data: true, error: null };
    });

    const { POST } = await import('@/app/api/razorpay/verify/route');
    const response = await POST(buildVerifyRequest(buildSignedPayload(), {
      'x-request-id': 'credit-verify-rate-limit-1',
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('41');
    expectPrivateNoStoreTraceHeaders(response, 'credit-verify-rate-limit-1');
    expect(mocks.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'credit-order:verify',
      p_subject_key: 'user_123',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('add_credits', expect.anything());
  });

  it('assigns credits only after signature, ownership, and transaction checks pass', async () => {
    mocks.userGetUser.mockResolvedValue({
      data: { user: { id: 'user_123' } },
      error: null,
    });

    const { POST } = await import('@/app/api/razorpay/verify/route');
    const response = await POST(buildVerifyRequest(buildSignedPayload(), {
      'x-request-id': 'credit-verify-success-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'credit-verify-success-1');
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith('transactions');
    expect(mocks.select).toHaveBeenCalledWith('id, credits, status');
    expect(mocks.firstEq).toHaveBeenCalledWith('razorpay_order_id', 'order_123');
    expect(mocks.secondEq).toHaveBeenCalledWith('user_id', 'user_123');
    expect(mocks.createServiceClient).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('add_credits', {
      p_credits: 500,
      p_payment_id: 'pay_123',
      p_transaction_id: 'txn_123',
      p_user_id: 'user_123',
    });
  });
});

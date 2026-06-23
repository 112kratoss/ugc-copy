import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let orderStatus: 'created' | 'paid' = 'created';
let rateLimitAllowed = true;
const completionRpcMock = vi.fn(async (_payload: unknown) => {
  void _payload;
  orderStatus = 'paid';
  return { data: true, error: null };
});
const serviceRpcMock = vi.fn(async (name: string, payload: unknown) => {
  if (name === 'check_backend_rate_limit') {
    return {
      data: {
        allowed: rateLimitAllowed,
        limit: 30,
        remaining: rateLimitAllowed ? 29 : 0,
        retryAfterSeconds: rateLimitAllowed ? 0 : 29,
        resetAt: '2026-06-22T06:30:00.000Z',
      },
      error: null,
    };
  }

  if (name === 'complete_marketplace_purchase') {
    return completionRpcMock(payload);
  }

  throw new Error(`Unexpected RPC: ${name}`);
});

const createUserClientMock = vi.fn();

function createServiceClientMock() {
  return {
    from(table: string) {
      if (table !== 'marketplace_orders') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    async maybeSingle() {
                      return {
                        data: {
                          id: 'order-row',
                          buyer_user_id: 'user-1',
                          status: orderStatus,
                        },
                        error: null,
                      };
                    },
                  };
                },
                async maybeSingle() {
                  return {
                    data: {
                      id: 'order-row',
                      buyer_user_id: 'user-1',
                      status: orderStatus,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
    rpc: serviceRpcMock,
  };
}

const createServiceClientFactory = vi.fn(() => createServiceClientMock());

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

describe('/api/marketplace/verify route', () => {
  beforeEach(() => {
    vi.resetModules();
    orderStatus = 'created';
    rateLimitAllowed = true;
    completionRpcMock.mockClear();
    serviceRpcMock.mockClear();
    createUserClientMock.mockReset();
    createServiceClientFactory.mockClear();
    createServiceClientFactory.mockImplementation(() => createServiceClientMock());
    createUserClientMock.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
        })),
      },
    });
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
  });

  it('does not create an admin client before authentication succeeds', async () => {
    createUserClientMock.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: new Error('missing session'),
        })),
      },
    });

    const { POST } = await import('@/app/api/marketplace/verify/route');
    const response = await POST(
      new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: 'Bearer private-token',
          'x-request-id': 'market-verify-auth-1',
        },
        body: JSON.stringify({}),
      }) as never
    );

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'market-verify-auth-1');
    expect(response.headers.has('authorization')).toBe(false);
    expect(Array.from(response.headers.entries()).join('\n')).not.toContain('private-token');
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(completionRpcMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rate limits payment verification before parsing payment details or completing the order', async () => {
    rateLimitAllowed = false;
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
      .update('order_123|pay_123')
      .digest('hex');
    const jsonMock = vi.fn(async () => ({
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: signature,
    }));

    const { POST } = await import('@/app/api/marketplace/verify/route');
    const response = await POST({
      headers: new Headers({
        Authorization: 'Bearer token',
        'x-request-id': 'market-verify-rate-limit-1',
      }),
      json: jsonMock,
    } as never);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('29');
    expectPrivateNoStoreTraceHeaders(response, 'market-verify-rate-limit-1');
    expect(serviceRpcMock).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'marketplace-order:verify',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(jsonMock).not.toHaveBeenCalled();
    expect(completionRpcMock).not.toHaveBeenCalled();
  });

  it('treats a second verify call as already processed', async () => {
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
      .update('order_123|pay_123')
      .digest('hex');

    const { POST } = await import('@/app/api/marketplace/verify/route');

    const firstResponse = await POST(
      new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
          'x-request-id': 'market-verify-success-1',
        },
        body: JSON.stringify({
          razorpay_order_id: 'order_123',
          razorpay_payment_id: 'pay_123',
          razorpay_signature: signature,
        }),
      }) as never
    );

    expect(firstResponse.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(firstResponse, 'market-verify-success-1');
    expect(completionRpcMock).toHaveBeenCalledTimes(1);

    const secondResponse = await POST(
      new Request('http://localhost/api/marketplace/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          razorpay_order_id: 'order_123',
          razorpay_payment_id: 'pay_123',
          razorpay_signature: signature,
        }),
      }) as never
    );

    const secondBody = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondBody).toEqual({ success: true, alreadyProcessed: true });
    expect(completionRpcMock).toHaveBeenCalledTimes(1);
  });
});

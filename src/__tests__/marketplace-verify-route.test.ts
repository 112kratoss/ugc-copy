import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let orderStatus: 'created' | 'paid' = 'created';
const rpcMock = vi.fn(async (_payload: unknown) => {
  void _payload;
  orderStatus = 'paid';
  return { data: true, error: null };
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
    rpc(name: string, payload: unknown) {
      if (name !== 'complete_marketplace_purchase') {
        throw new Error(`Unexpected RPC: ${name}`);
      }

      return rpcMock(payload);
    },
  };
}

const createServiceClientFactory = vi.fn(() => createServiceClientMock());

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientFactory(),
}));

describe('/api/marketplace/verify route', () => {
  beforeEach(() => {
    vi.resetModules();
    orderStatus = 'created';
    rpcMock.mockClear();
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(createServiceClientFactory).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
        },
        body: JSON.stringify({
          razorpay_order_id: 'order_123',
          razorpay_payment_id: 'pay_123',
          razorpay_signature: signature,
        }),
      }) as never
    );

    expect(firstResponse.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledTimes(1);

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
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OrderStatus = 'created' | 'paid';

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  status: 'pending' | 'success';
} | null;

type MarketplaceOrderRow = {
  id: string;
  buyer_user_id: string;
  status: OrderStatus;
} | null;

type BundleOrderRow = {
  id: string;
  buyer_user_id: string;
  amount_subunits: number;
  currency: string;
  razorpay_payment_id: string | null;
  status: OrderStatus;
} | null;

let creditTransactionState: CreditTransactionRow = null;
let marketplaceOrderState: MarketplaceOrderRow = null;
let bundleOrderState: BundleOrderRow = null;
let bundleRpcMode: 'success' | 'fail-return' | 'error' = 'success';
const rpcMock = vi.fn(async (name: string, payload: Record<string, unknown>) => {
  void payload;

  if (name === 'complete_post_resource_bundle_purchase') {
    if (bundleRpcMode === 'error') {
      return {
        data: null,
        error: { message: 'bundle rpc failed' },
      };
    }

    if (bundleRpcMode === 'fail-return') {
      return {
        data: false,
        error: null,
      };
    }

    if (bundleOrderState) {
      bundleOrderState.status = 'paid';
    }

    return {
      data: true,
      error: null,
    };
  }

  if (name === 'complete_marketplace_purchase' && marketplaceOrderState) {
    marketplaceOrderState.status = 'paid';
    return {
      data: true,
      error: null,
    };
  }

  if (name === 'add_credits' && creditTransactionState) {
    creditTransactionState.status = 'success';
    return {
      data: true,
      error: null,
    };
  }

  return {
    data: null,
    error: null,
  };
});

function createSupabaseAdminMock() {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq(_column: string, _value: unknown) {
              void _column;
              void _value;

              return {
                async maybeSingle() {
                  if (table === 'transactions') {
                    return { data: creditTransactionState, error: null };
                  }

                  if (table === 'marketplace_orders') {
                    return { data: marketplaceOrderState, error: null };
                  }

                  if (table === 'post_resource_bundle_orders') {
                    return { data: bundleOrderState, error: null };
                  }

                  throw new Error(`Unexpected table access: ${table}`);
                },
              };
            },
          };
        },
      };
    },
    rpc(name: string, payload: Record<string, unknown>) {
      return rpcMock(name, payload);
    },
  };
}

const createClientMock = vi.fn((..._args: unknown[]) => {
  void _args;
  return createSupabaseAdminMock();
});

const createServiceClientMock = vi.fn((..._args: unknown[]) => {
  void _args;
  return createSupabaseAdminMock();
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}));

function buildSignedWebhookRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const serializedBody = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET as string)
    .update(serializedBody)
    .digest('hex');

  return new Request('http://localhost/api/razorpay/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
      ...headers,
    },
    body: serializedBody,
  });
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

function capturedPaymentEntity() {
  return {
    id: 'pay_123',
    order_id: 'order_123',
    amount: 41500,
    amount_refunded: 0,
    currency: 'INR',
    status: 'captured',
    captured: true,
    notes: {
      buyer_user_id: 'user-1',
    },
  };
}

describe('/api/razorpay/webhook route', () => {
  beforeEach(() => {
    vi.resetModules();
    creditTransactionState = null;
    marketplaceOrderState = null;
    bundleOrderState = null;
    bundleRpcMode = 'success';
    rpcMock.mockClear();
    createClientMock.mockClear();
    createServiceClientMock.mockClear();
    process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook-secret';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finalizes post resource bundle orders from payment.captured', async () => {
    bundleOrderState = {
      id: 'bundle-order-1',
      buyer_user_id: 'user-1',
      amount_subunits: 41500,
      currency: 'INR',
      razorpay_payment_id: null,
      status: 'created',
    };

    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(buildSignedWebhookRequest(
      {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: capturedPaymentEntity(),
          },
        },
      },
      { 'x-request-id': 'razorpay-webhook-bundle-success-1' }
    ));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'razorpay-webhook-bundle-success-1');
    expect(bundleOrderState.status).toBe('paid');
    expect(rpcMock).toHaveBeenCalledWith('complete_post_resource_bundle_purchase', {
      p_razorpay_order_id: 'order_123',
      p_razorpay_payment_id: 'pay_123',
    });
  });

  it('rejects oversized signed payloads before creating a privileged Supabase client', async () => {
    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(buildSignedWebhookRequest(
      {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_123',
              order_id: 'order_123',
            },
          },
        },
      },
      {
        'content-length': '262145',
        'x-request-id': 'razorpay-webhook-oversized-1',
      }
    ));

    expect(response.status).toBe(413);
    expectPrivateNoStoreTraceHeaders(response, 'razorpay-webhook-oversized-1');
    expect(createServiceClientMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('treats already-paid post resource bundle orders as idempotent', async () => {
    bundleOrderState = {
      id: 'bundle-order-1',
      buyer_user_id: 'user-1',
      amount_subunits: 41500,
      currency: 'INR',
      razorpay_payment_id: 'pay_123',
      status: 'paid',
    };

    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(buildSignedWebhookRequest({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: capturedPaymentEntity(),
        },
      },
    }));

    expect(response.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalledWith(
      'complete_post_resource_bundle_purchase',
      expect.anything()
    );
  });

  it('returns 500 when bundle completion fails and the order stays unresolved', async () => {
    bundleOrderState = {
      id: 'bundle-order-1',
      buyer_user_id: 'user-1',
      amount_subunits: 41500,
      currency: 'INR',
      razorpay_payment_id: null,
      status: 'created',
    };
    bundleRpcMode = 'fail-return';

    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(buildSignedWebhookRequest({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: capturedPaymentEntity(),
        },
      },
    }));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Failed to finalize post resource bundle purchase');
    expect(bundleOrderState.status).toBe('created');
  });

  it('returns 200 when payment.captured does not match any known order', async () => {
    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(buildSignedWebhookRequest({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: capturedPaymentEntity(),
        },
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures before creating a privileged Supabase client', async () => {
    const { POST } = await import('@/app/api/razorpay/webhook/route');
    const response = await POST(
      new Request('http://localhost/api/razorpay/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-razorpay-signature': 'invalid-signature',
          'x-request-id': 'razorpay-webhook-invalid-signature-1',
        },
        body: JSON.stringify({
          event: 'payment.captured',
          payload: {
            payment: {
              entity: {
                id: 'pay_123',
                order_id: 'order_123',
              },
            },
          },
        }),
      })
    );

    expect(response.status).toBe(400);
    expectPrivateNoStoreTraceHeaders(response, 'razorpay-webhook-invalid-signature-1');
    expect(await response.text()).toBe('Invalid signature');
    expect(createClientMock).not.toHaveBeenCalled();
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });
});

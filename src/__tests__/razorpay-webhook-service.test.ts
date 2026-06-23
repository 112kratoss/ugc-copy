import { describe, expect, it, vi } from 'vitest';

import { processRazorpayWebhookForRoute } from '@/lib/razorpay-webhook-service';

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  status: 'pending' | 'success';
} | null;

type OrderRow = {
  id: string;
  buyer_user_id: string;
  status: 'created' | 'paid';
} | null;

function createAdminSupabaseMock(state: {
  creditTransaction?: CreditTransactionRow;
  marketplaceOrder?: OrderRow;
  bundleOrder?: OrderRow;
  bundleRpcMode?: 'success' | 'fail-return' | 'error';
}) {
  const tableReads: string[] = [];
  const rpcCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq(_column: string, _value: unknown) {
              void _column;
              void _value;
              return {
                async maybeSingle() {
                  tableReads.push(table);

                  if (table === 'transactions') {
                    return { data: state.creditTransaction ?? null, error: null };
                  }

                  if (table === 'marketplace_orders') {
                    return { data: state.marketplaceOrder ?? null, error: null };
                  }

                  if (table === 'post_resource_bundle_orders') {
                    return { data: state.bundleOrder ?? null, error: null };
                  }

                  throw new Error(`Unexpected table access: ${table}`);
                },
              };
            },
          };
        },
      };
    },
    async rpc(name: string, payload: Record<string, unknown>) {
      rpcCalls.push({ name, payload });

      if (name === 'add_credits' && state.creditTransaction) {
        state.creditTransaction.status = 'success';
        return { data: true, error: null };
      }

      if (name === 'complete_marketplace_purchase' && state.marketplaceOrder) {
        state.marketplaceOrder.status = 'paid';
        return { data: true, error: null };
      }

      if (name === 'complete_post_resource_bundle_purchase') {
        if (state.bundleRpcMode === 'error') {
          return { data: null, error: { message: 'bundle rpc failed' } };
        }

        if (state.bundleRpcMode === 'fail-return') {
          return { data: false, error: null };
        }

        if (state.bundleOrder) {
          state.bundleOrder.status = 'paid';
        }

        return { data: true, error: null };
      }

      return { data: null, error: null };
    },
  };

  return {
    client,
    rpcCalls,
    tableReads,
  };
}

function paymentCapturedBody(orderId = 'order_123') {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_123',
          order_id: orderId,
        },
      },
    },
  });
}

describe('processRazorpayWebhookForRoute', () => {
  it('settles credit purchases first and stops before marketplace lookups', async () => {
    const admin = createAdminSupabaseMock({
      creditTransaction: {
        id: 'txn-1',
        user_id: 'user-1',
        credits: 100,
        status: 'pending',
      },
      marketplaceOrder: {
        id: 'marketplace-order-1',
        buyer_user_id: 'user-1',
        status: 'created',
      },
      bundleOrder: {
        id: 'bundle-order-1',
        buyer_user_id: 'user-1',
        status: 'created',
      },
    });
    const createAdminSupabase = vi.fn(() => admin.client);

    const result = await processRazorpayWebhookForRoute({
      createAdminSupabase,
      rawBody: paymentCapturedBody(),
    });

    expect(result).toEqual({ status: 200, body: 'OK' });
    expect(admin.tableReads).toEqual(['transactions']);
    expect(admin.rpcCalls).toEqual([
      {
        name: 'add_credits',
        payload: {
          p_user_id: 'user-1',
          p_credits: 100,
          p_transaction_id: 'txn-1',
          p_payment_id: 'pay_123',
        },
      },
    ]);
    expect(createAdminSupabase).toHaveBeenCalledTimes(1);
  });

  it('asks Razorpay to retry when bundle completion remains unresolved', async () => {
    const admin = createAdminSupabaseMock({
      bundleOrder: {
        id: 'bundle-order-1',
        buyer_user_id: 'user-1',
        status: 'created',
      },
      bundleRpcMode: 'fail-return',
    });

    const result = await processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: paymentCapturedBody(),
    });

    expect(result).toEqual({
      status: 500,
      body: 'Failed to finalize post resource bundle purchase',
    });
    expect(admin.rpcCalls).toEqual([
      {
        name: 'complete_post_resource_bundle_purchase',
        payload: {
          p_razorpay_order_id: 'order_123',
          p_razorpay_payment_id: 'pay_123',
        },
      },
    ]);
    expect(admin.tableReads).toEqual([
      'transactions',
      'marketplace_orders',
      'post_resource_bundle_orders',
      'post_resource_bundle_orders',
    ]);
  });
});

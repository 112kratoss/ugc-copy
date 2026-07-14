import { describe, expect, it, vi } from 'vitest';

import { processRazorpayWebhookForRoute } from '@/lib/razorpay-webhook-service';

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  amount?: number;
  credit_reversed_amount_subunits?: number;
  credit_effect_applied?: boolean;
  razorpay_payment_id?: string;
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
  creditRpcMode?: 'success' | 'false-settled' | 'false-mismatched' | 'false-unsettled' | 'error';
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
        if (state.creditRpcMode === 'error') {
          return { data: null, error: { message: 'credit rpc failed' } };
        }

        if (state.creditRpcMode === 'false-unsettled') {
          return { data: false, error: null };
        }

        state.creditTransaction.status = 'success';
        state.creditTransaction.credit_effect_applied = true;
        state.creditTransaction.razorpay_payment_id = state.creditRpcMode === 'false-mismatched'
          ? 'pay_other'
          : String(payload.p_payment_id);
        return {
          data: !['false-settled', 'false-mismatched'].includes(state.creditRpcMode ?? ''),
          error: null,
        };
      }

      if (name === 'settle_referral_purchase_rewards') {
        return { data: { status: 'not_referred', rewards: [] }, error: null };
      }

      if (name === 'reconcile_razorpay_credit_purchase_adjustment') {
        return { data: { status: 'partially_reversed', rewards: [] }, error: null };
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

function refundProcessedBody() {
  return JSON.stringify({
    event: 'refund.processed',
    payload: {
      payment: { entity: { id: 'pay_123', order_id: 'order_123', amount: 10_000, amount_refunded: 5_000 } },
      refund: { entity: { id: 'rfnd_123', payment_id: 'pay_123', amount: 5_000, status: 'processed' } },
    },
  });
}

function disputeBody(eventName: string, status: string) {
  return JSON.stringify({
    event: eventName,
    payload: {
      payment: { entity: { id: 'pay_123', order_id: 'order_123', amount: 10_000, amount_refunded: 0 } },
      dispute: { entity: { id: 'disp_123', payment_id: 'pay_123', amount: 3_000, status } },
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
      {
        name: 'settle_referral_purchase_rewards',
        payload: {
          p_transaction_id: 'txn-1',
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

  it('accepts an add_credits false result only after verifying concurrent durable settlement', async () => {
    const admin = createAdminSupabaseMock({
      creditTransaction: {
        id: 'txn-1',
        user_id: 'user-1',
        credits: 100,
        status: 'pending',
      },
      creditRpcMode: 'false-settled',
    });

    const result = await processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: paymentCapturedBody(),
    });

    expect(result).toEqual({ status: 200, body: 'OK' });
    expect(admin.tableReads).toEqual(['transactions', 'transactions']);
    expect(admin.rpcCalls).toContainEqual({
      name: 'settle_referral_purchase_rewards',
      payload: { p_transaction_id: 'txn-1' },
    });
  });

  it('asks Razorpay to retry when add_credits returns false without durable settlement', async () => {
    const admin = createAdminSupabaseMock({
      creditTransaction: {
        id: 'txn-1',
        user_id: 'user-1',
        credits: 100,
        status: 'pending',
      },
      creditRpcMode: 'false-unsettled',
    });

    const result = await processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: paymentCapturedBody(),
    });

    expect(result).toEqual({ status: 500, body: 'Failed to assign credits' });
    expect(admin.rpcCalls).not.toContainEqual(expect.objectContaining({
      name: 'settle_referral_purchase_rewards',
    }));
  });

  it('asks Razorpay to retry when a false result resolves to a different payment id', async () => {
    const admin = createAdminSupabaseMock({
      creditTransaction: {
        id: 'txn-1',
        user_id: 'user-1',
        credits: 100,
        status: 'pending',
      },
      creditRpcMode: 'false-mismatched',
    });

    await expect(processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: paymentCapturedBody(),
    })).resolves.toEqual({ status: 500, body: 'Failed to assign credits' });
    expect(admin.rpcCalls).not.toContainEqual(expect.objectContaining({
      name: 'settle_referral_purchase_rewards',
    }));
  });

  it('reconciles a processed partial refund from the provider cumulative amount', async () => {
    const admin = createAdminSupabaseMock({
      creditTransaction: {
        id: 'txn-1',
        user_id: 'user-1',
        credits: 100,
        amount: 10_000,
        credit_reversed_amount_subunits: 0,
        razorpay_payment_id: 'pay_123',
        status: 'success',
      },
    });

    const result = await processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: refundProcessedBody(),
    });

    expect(result).toEqual({ status: 200, body: 'OK' });
    expect(admin.rpcCalls).toContainEqual({
      name: 'reconcile_razorpay_credit_purchase_adjustment',
      payload: {
        p_transaction_id: 'txn-1',
        p_provider_event_id: 'refund:rfnd_123',
        p_cumulative_reversed_subunits: 5_000,
        p_action: 'reverse',
        p_reason: 'razorpay_refund_processed',
      },
    });
  });

  it('reverses an opened dispute and restores only that amount when won', async () => {
    const transaction = {
      id: 'txn-1',
      user_id: 'user-1',
      credits: 100,
      amount: 10_000,
      credit_reversed_amount_subunits: 0,
      razorpay_payment_id: 'pay_123',
      status: 'success' as const,
    };
    const admin = createAdminSupabaseMock({ creditTransaction: transaction });

    await expect(processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: disputeBody('payment.dispute.created', 'open'),
    })).resolves.toEqual({ status: 200, body: 'OK' });

    transaction.credit_reversed_amount_subunits = 3_000;
    await expect(processRazorpayWebhookForRoute({
      createAdminSupabase: () => admin.client,
      rawBody: disputeBody('payment.dispute.won', 'won'),
    })).resolves.toEqual({ status: 200, body: 'OK' });

    expect(admin.rpcCalls).toEqual(expect.arrayContaining([
      {
        name: 'reconcile_razorpay_credit_purchase_adjustment',
        payload: expect.objectContaining({
          p_provider_event_id: 'dispute:disp_123:reverse',
          p_cumulative_reversed_subunits: 3_000,
          p_action: 'reverse',
        }),
      },
      {
        name: 'reconcile_razorpay_credit_purchase_adjustment',
        payload: expect.objectContaining({
          p_provider_event_id: 'dispute:disp_123:won',
          p_cumulative_reversed_subunits: 0,
          p_action: 'restore',
        }),
      },
    ]));
  });
});

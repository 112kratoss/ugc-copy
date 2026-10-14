import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  notifyRazorpayMarketplacePurchase,
  verifyMarketplacePaymentForRoute as verifyMarketplacePaymentForRouteImpl,
} from '@/lib/marketplace-verify-service';

type OrderRow = {
  id: string;
  buyer_user_id: string;
  status: 'created' | 'paid' | 'failed';
};

function signatureFor(orderId: string, paymentId: string, secret = 'test-secret') {
  return crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

function createAdminSupabaseMock({
  order = { id: 'order-row', buyer_user_id: 'user-1', status: 'created' } as OrderRow | null,
  rateLimitAllowed = true,
  completionResult = true,
  completionError = null as { message: string } | null,
  refreshedStatus = 'paid' as OrderRow['status'],
  /** The resource a settled order names, and its seller. */
  settledAsset = null as { assetId: string; sellerUserId: string } | null,
} = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as string[],
    filters: [] as Array<[string, unknown]>,
  };

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table === 'marketplace_assets' && settledAsset) {
        const assetQuery = {
          select: () => assetQuery,
          eq(column: string, value: unknown) {
            calls.filters.push([column, value]);
            return assetQuery;
          },
          maybeSingle: async () => ({ data: { seller_user_id: settledAsset.sellerUserId }, error: null }),
        };
        return assetQuery;
      }
      if (table !== 'marketplace_orders') {
        throw new Error(`Unexpected table: ${table}`);
      }

      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          calls.filters.push([column, value]);
          return query;
        },
        async maybeSingle() {
          if (calls.rpc.some((call) => call.name === 'complete_marketplace_purchase')) {
            return {
              data: order
                ? {
                    status: refreshedStatus,
                    razorpay_payment_id: 'pay_123',
                    ...(settledAsset ? { asset_id: settledAsset.assetId, buyer_user_id: order.buyer_user_id } : {}),
                  }
                : null,
              error: null,
            };
          }

          return {
            data: order
              ? {
                  amount_subunits: 12_300,
                  currency: 'INR',
                  razorpay_payment_id: order.status === 'paid' ? 'pay_123' : null,
                  ...order,
                }
              : null,
            error: null,
          };
        },
      };

      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name === 'check_backend_rate_limit') {
        return Promise.resolve({
          data: {
            allowed: rateLimitAllowed,
            limit: 30,
            remaining: rateLimitAllowed ? 29 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 29,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        });
      }

      if (name === 'complete_marketplace_purchase') {
        return Promise.resolve({
          data: completionResult,
          error: completionError,
        });
      }

      throw new Error(`Unexpected RPC: ${name}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
  };
}

function validBody() {
  return {
    razorpay_order_id: 'order_123',
    razorpay_payment_id: 'pay_123',
    razorpay_signature: signatureFor('order_123', 'pay_123'),
  };
}

function verifyMarketplacePaymentForRoute(
  input: Parameters<typeof verifyMarketplacePaymentForRouteImpl>[0],
) {
  return verifyMarketplacePaymentForRouteImpl({
    keyId: 'test-key',
    fetchPayment: vi.fn(async ({ paymentId }) => ({
      id: paymentId,
      orderId: 'order_123',
      amount: 12_300,
      amountRefunded: 0,
      currency: 'INR',
      status: 'captured' as const,
      captured: true,
      notes: { buyer_user_id: 'user-1' },
    })),
    ...input,
  });
}

describe('verifyMarketplacePaymentForRoute', () => {
  it('rate limits before parsing payment details or loading the order', async () => {
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });
    const readBody = vi.fn(async () => validBody());

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result).toHaveProperty('rateLimitError');
    expect(readBody).not.toHaveBeenCalled();
    expect(admin.calls.tables).toEqual([]);
    expect(admin.calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'marketplace-order:verify',
          p_subject_key: 'user-1',
          p_limit: 30,
          p_window_seconds: 600,
        },
      },
    ]);
  });

  it('rejects invalid signatures before loading or completing an order', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => ({
        ...validBody(),
        razorpay_signature: 'bad-signature',
      })),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid payment signature.' },
    });
    expect(admin.calls.tables).toEqual([]);
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('completes an owned created order after signature verification', async () => {
    const admin = createAdminSupabaseMock();
    const notifyPurchase = vi.fn(async () => null);

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      notifyPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(admin.calls.rpc).toContainEqual({
      name: 'complete_marketplace_purchase',
      args: {
        p_razorpay_order_id: 'order_123',
        p_razorpay_payment_id: 'pay_123',
      },
    });
    // This verify settled it, so the buyer and the seller are told from here, once.
    expect(notifyPurchase).toHaveBeenCalledTimes(1);
    expect(notifyPurchase).toHaveBeenCalledWith(admin.client, 'order_123');
  });

  it('treats an already paid order as idempotently processed', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'user-1', status: 'paid' },
    });
    const notifyPurchase = vi.fn();

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      notifyPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
    // Whoever settled it first sent its alerts.
    expect(notifyPurchase).not.toHaveBeenCalled();
  });

  it('returns not found when the order belongs to another buyer', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'other-user', status: 'created' },
    });

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Order not found.' },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('returns already processed when completion races with another verifier', async () => {
    const admin = createAdminSupabaseMock({ completionResult: false, refreshedStatus: 'paid' });
    const notifyPurchase = vi.fn();

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      notifyPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.tables).toEqual(['marketplace_orders', 'marketplace_orders']);
    // The webhook settled it, and it sends the alerts.
    expect(notifyPurchase).not.toHaveBeenCalled();
  });

  it('returns 202 without creating an entitlement for an authorized payment', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_123',
        orderId: 'order_123',
        amount: 12_300,
        amountRefunded: 0,
        currency: 'INR',
        status: 'authorized' as const,
        captured: false,
        notes: { buyer_user_id: 'user-1' },
      })),
    });

    expect(result).toEqual({
      ok: true,
      status: 202,
      body: expect.objectContaining({
        status: 'pending',
        pending: true,
        code: 'PAYMENT_PENDING',
      }),
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('rejects a captured payment bound to another buyer', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_123',
        orderId: 'order_123',
        amount: 12_300,
        amountRefunded: 0,
        currency: 'INR',
        status: 'captured' as const,
        captured: true,
        notes: { buyer_user_id: 'other-user' },
      })),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Payment details do not match the order.' },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });
});

describe('alerts for a marketplace resource bought on the web', () => {
  // The real alerts, written to notification history: what a purchase made in
  // the app writes, "Resource unlocked" and "You made a resource sale".
  const settledAsset = { assetId: 'asset-1', sellerUserId: 'seller-1' };
  const purchaseAlerts = [
    expect.objectContaining({
      user_id: 'user-1',
      type: 'marketplace_unlocked',
      category: 'commerce',
      deep_link: '/marketplace/asset-1',
      dedupe_key: 'marketplace-unlock:asset-1:user-1',
    }),
    expect.objectContaining({
      user_id: 'seller-1',
      actor_user_id: 'user-1',
      type: 'marketplace_unlocked',
      category: 'commerce',
      deep_link: '/marketplace/asset-1',
      dedupe_key: 'marketplace-sale:asset-1:user-1',
    }),
  ];

  function settle(
    admin: ReturnType<typeof createAdminSupabaseMock>,
    history: ReturnType<typeof createMobileNotificationHistory>,
    runAfterResponse?: (task: () => Promise<unknown>) => void,
  ) {
    return verifyMarketplacePaymentForRoute({
      adminSupabase: withMobileNotificationHistory(admin.client, history),
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      runAfterResponse,
    });
  }

  it('tells the buyer and the seller, once, behind the answer of the verify that settled it', async () => {
    const admin = createAdminSupabaseMock({ settledAsset });
    const history = createMobileNotificationHistory();
    const deferred: Array<() => Promise<unknown>> = [];

    await expect(settle(admin, history, (task) => { deferred.push(task); }))
      .resolves.toEqual({ ok: true, body: { success: true } });
    // The checkout's answer waits on no alert.
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    await deferred[0]();
    expect(history.sent).toEqual(purchaseAlerts);
    // The seller is the resource's, read from the order the checkout names.
    expect(admin.calls.filters).toContainEqual(['id', 'asset-1']);
  });

  it('tells them before answering when the caller has nowhere to run work after it', async () => {
    const admin = createAdminSupabaseMock({ settledAsset });
    const history = createMobileNotificationHistory();
    history.hold();

    const verification = settle(admin, history);
    expect(await hasAnswered(verification)).toBe(false);

    history.release();
    await expect(verification).resolves.toEqual({ ok: true, body: { success: true } });
    expect(history.sent).toEqual(purchaseAlerts);
  });

  it.each([
    ['an order that was already paid', { order: { id: 'order-row', buyer_user_id: 'user-1', status: 'paid' as const } }],
    ['an order the webhook settled at the same moment', { completionResult: false }],
  ])('tells nobody from the verify for %s: whoever settled it did', async (_kind, options) => {
    const admin = createAdminSupabaseMock({ ...options, settledAsset });
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await expect(settle(admin, history, runAfterResponse))
      .resolves.toEqual({ ok: true, body: { success: true, alreadyProcessed: true } });
    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.sent).toEqual([]);
  });

  it('sends nothing, and never throws, when the order cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const history = createMobileNotificationHistory();
    const unreadable = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'read failed' } }) }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(notifyRazorpayMarketplacePurchase(withMobileNotificationHistory(unreadable, history), 'order_123'))
      .resolves.toBeNull();
    expect(history.started).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('razorpay_marketplace_notification_failed'));
    errorSpy.mockRestore();
  });
});

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  notifyRazorpayPostResourcePurchase,
  verifyPostResourceBundlePaymentForRoute as verifyPostResourceBundlePaymentForRouteImpl,
} from '@/lib/post-resource-bundle-verify-service';

type BundleOrderRow = {
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

function validBody() {
  return {
    razorpay_order_id: 'order_bundle_123',
    razorpay_payment_id: 'pay_bundle_123',
    razorpay_signature: signatureFor('order_bundle_123', 'pay_bundle_123'),
  };
}

function verifyPostResourceBundlePaymentForRoute(
  input: Parameters<typeof verifyPostResourceBundlePaymentForRouteImpl>[0],
) {
  return verifyPostResourceBundlePaymentForRouteImpl({
    keyId: 'test-key',
    fetchPayment: vi.fn(async ({ paymentId }) => ({
      id: paymentId,
      orderId: 'order_bundle_123',
      amount: 9_900,
      amountRefunded: 0,
      currency: 'INR',
      status: 'captured' as const,
      captured: true,
      notes: { buyer_user_id: 'buyer-1' },
    })),
    ...input,
  });
}

/** What a settled order's bundle names: the post and its owner. */
const settledBundleOrder = {
  bundle_id: 'bundle-1',
  buyer_user_id: 'buyer-1',
  post_resource_bundles: { post_id: 'post-1', owner_user_id: 'owner-1' },
};

function createAdminSupabaseMock({
  order = { id: 'order-row', buyer_user_id: 'buyer-1', status: 'created' } as BundleOrderRow | null,
  rateLimitAllowed = true,
  completionResult = true,
  completionError = null as { message: string } | null,
  refreshedStatus = 'paid' as BundleOrderRow['status'],
  /** Read once the purchase is settled, beside its status. */
  settledOrder = {} as Record<string, unknown>,
} = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as string[],
    filters: [] as Array<[string, unknown]>,
  };

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table !== 'post_resource_bundle_orders') {
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
          if (calls.rpc.some((call) => call.name === 'complete_post_resource_bundle_purchase')) {
            return {
              data: order
                ? { status: refreshedStatus, razorpay_payment_id: 'pay_bundle_123', ...settledOrder }
                : null,
              error: null,
            };
          }

          return {
            data: order
              ? {
                  amount_subunits: 9_900,
                  currency: 'INR',
                  razorpay_payment_id: order.status === 'paid' ? 'pay_bundle_123' : null,
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
            retryAfterSeconds: rateLimitAllowed ? 0 : 17,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        });
      }

      if (name === 'complete_post_resource_bundle_purchase') {
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

describe('verifyPostResourceBundlePaymentForRoute', () => {
  it('rate limits before parsing payment details or loading the order', async () => {
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });
    const readBody = vi.fn(async () => validBody());

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
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
          p_scope: 'post-resource-order:verify',
          p_subject_key: 'buyer-1',
          p_limit: 30,
          p_window_seconds: 600,
        },
      },
    ]);
  });

  it('rejects missing payment parameters after verification rate limiting', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => ({})),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Missing required payment parameters.' },
    });
    expect(admin.calls.tables).toEqual([]);
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('rejects invalid signatures before loading or completing an order', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
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

  it('completes an owned created bundle order after signature verification', async () => {
    const admin = createAdminSupabaseMock();
    const invalidateMarketplaceResourceListCache = vi.fn();
    const recordPurchaseFeedEvent = vi.fn(async () => ({ status: 'recorded' as const, deliveryId: null }));
    const notifyPurchase = vi.fn(async () => null);

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache,
      recordPurchaseFeedEvent,
      notifyPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(admin.calls.tables).toEqual(['post_resource_bundle_orders']);
    expect(admin.calls.filters).toEqual([
      ['razorpay_order_id', 'order_bundle_123'],
    ]);
    expect(admin.calls.rpc).toContainEqual({
      name: 'complete_post_resource_bundle_purchase',
      args: {
        p_razorpay_order_id: 'order_bundle_123',
        p_razorpay_payment_id: 'pay_bundle_123',
      },
    });
    expect(invalidateMarketplaceResourceListCache).toHaveBeenCalledTimes(1);
    // v4's server-written purchase event, once the purchase is settled.
    expect(recordPurchaseFeedEvent).toHaveBeenCalledTimes(1);
    expect(recordPurchaseFeedEvent).toHaveBeenCalledWith(admin.client, { razorpayOrderId: 'order_bundle_123' });
    // This verify settled it, so the buyer and the owner are told from here, once.
    expect(notifyPurchase).toHaveBeenCalledTimes(1);
    expect(notifyPurchase).toHaveBeenCalledWith(admin.client, 'order_bundle_123');
  });

  it('answers a settled purchase even when its feed event fails', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache: vi.fn(),
      recordPurchaseFeedEvent: vi.fn(async () => ({ status: 'failed' as const, reason: 'error' as const })),
      notifyPurchase: vi.fn(async () => null),
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
  });

  it('treats already paid orders as idempotently processed', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'buyer-1', status: 'paid' },
    });
    const recordPurchaseFeedEvent = vi.fn();
    const notifyPurchase = vi.fn();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      recordPurchaseFeedEvent,
      notifyPurchase,
    });
    // Whoever settled it first wrote its feed event and sent its alerts.
    expect(recordPurchaseFeedEvent).not.toHaveBeenCalled();
    expect(notifyPurchase).not.toHaveBeenCalled();

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('returns not found when the bundle order belongs to another buyer', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'other-buyer', status: 'created' },
    });

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
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
    const invalidateMarketplaceResourceListCache = vi.fn();
    const notifyPurchase = vi.fn();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache,
      notifyPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.tables).toEqual([
      'post_resource_bundle_orders',
      'post_resource_bundle_orders',
    ]);
    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
    // The webhook settled it, and it sends the alerts.
    expect(notifyPurchase).not.toHaveBeenCalled();
  });

  it('maps unresolved completion attempts to a stable finalize error', async () => {
    const admin = createAdminSupabaseMock({
      completionResult: false,
      refreshedStatus: 'created',
    });

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Unable to finalize purchase.' },
    });
  });

  it('maps completion RPC failures to a stable purchase error', async () => {
    const admin = createAdminSupabaseMock({
      completionResult: false,
      completionError: { message: 'rpc failed' },
    });

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to complete purchase.' },
    });
  });

  it('returns 202 without unlocking resources for an authorized payment', async () => {
    const admin = createAdminSupabaseMock();
    const invalidateMarketplaceResourceListCache = vi.fn();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_bundle_123',
        orderId: 'order_bundle_123',
        amount: 9_900,
        amountRefunded: 0,
        currency: 'INR',
        status: 'authorized' as const,
        captured: false,
        notes: { buyer_user_id: 'buyer-1' },
      })),
      invalidateMarketplaceResourceListCache,
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
    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
  });

  it('rejects a captured payment with a mismatched currency', async () => {
    const admin = createAdminSupabaseMock();

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_bundle_123',
        orderId: 'order_bundle_123',
        amount: 9_900,
        amountRefunded: 0,
        currency: 'USD',
        status: 'captured' as const,
        captured: true,
        notes: { buyer_user_id: 'buyer-1' },
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

describe('alerts for a recipe bought on the web', () => {
  // The real alerts, written to notification history: what a purchase made in
  // the app writes, "Post resources unlocked" and "Someone unlocked your post".
  const purchaseAlerts = [
    expect.objectContaining({
      user_id: 'buyer-1',
      type: 'post_resource_unlocked',
      category: 'commerce',
      deep_link: '/showcase/post-1',
      dedupe_key: 'post-resource-unlock:post-1:buyer-1',
    }),
    expect.objectContaining({
      user_id: 'owner-1',
      actor_user_id: 'buyer-1',
      type: 'post_resource_unlocked',
      category: 'social',
      deep_link: '/showcase/post-1',
      dedupe_key: 'post-resource-sale:post-1:buyer-1',
    }),
  ];

  function settle(
    admin: ReturnType<typeof createAdminSupabaseMock>,
    history: ReturnType<typeof createMobileNotificationHistory>,
    runAfterResponse?: (task: () => Promise<unknown>) => void,
  ) {
    return verifyPostResourceBundlePaymentForRoute({
      adminSupabase: withMobileNotificationHistory(admin.client, history),
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache: vi.fn(),
      recordPurchaseFeedEvent: vi.fn(async () => ({ status: 'recorded' as const, deliveryId: null })),
      runAfterResponse,
    });
  }

  it('tells the buyer and the owner, once, behind the answer of the verify that settled it', async () => {
    const admin = createAdminSupabaseMock({ settledOrder: settledBundleOrder });
    const history = createMobileNotificationHistory();
    const deferred: Array<() => Promise<unknown>> = [];

    await expect(settle(admin, history, (task) => { deferred.push(task); }))
      .resolves.toEqual({ ok: true, body: { success: true } });
    // The checkout's answer waits on no alert.
    expect(history.started).toEqual([]);
    expect(deferred).toHaveLength(1);

    await deferred[0]();
    expect(history.sent).toEqual(purchaseAlerts);
  });

  it('tells them before answering when the caller has nowhere to run work after it', async () => {
    const admin = createAdminSupabaseMock({ settledOrder: settledBundleOrder });
    const history = createMobileNotificationHistory();
    history.hold();

    const verification = settle(admin, history);
    expect(await hasAnswered(verification)).toBe(false);

    history.release();
    await expect(verification).resolves.toEqual({ ok: true, body: { success: true } });
    expect(history.sent).toEqual(purchaseAlerts);
  });

  it.each([
    ['an order that was already paid', { order: { id: 'order-row', buyer_user_id: 'buyer-1', status: 'paid' as const } }],
    ['an order the webhook settled at the same moment', { completionResult: false }],
  ])('tells nobody from the verify for %s: whoever settled it did', async (_kind, options) => {
    const admin = createAdminSupabaseMock({ ...options, settledOrder: settledBundleOrder });
    const history = createMobileNotificationHistory();
    const runAfterResponse = vi.fn();

    await expect(settle(admin, history, runAfterResponse))
      .resolves.toEqual({ ok: true, body: { success: true, alreadyProcessed: true } });
    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.sent).toEqual([]);
  });

  it('reads the post and its owner from the order the checkout names', async () => {
    const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const orders = {
      from(table: string) {
        const read = { table, filters: [] as Array<[string, unknown]> };
        reads.push(read);
        const query = {
          select: () => query,
          eq(column: string, value: unknown) {
            read.filters.push([column, value]);
            return query;
          },
          maybeSingle: async () => ({ data: settledBundleOrder, error: null }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const history = createMobileNotificationHistory();

    await notifyRazorpayPostResourcePurchase(withMobileNotificationHistory(orders, history), 'order_bundle_123');

    expect(reads).toEqual([{ table: 'post_resource_bundle_orders', filters: [['razorpay_order_id', 'order_bundle_123']] }]);
    expect(history.sent).toEqual(purchaseAlerts);
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

    await expect(notifyRazorpayPostResourcePurchase(withMobileNotificationHistory(unreadable, history), 'order_bundle_123'))
      .resolves.toBeNull();
    expect(history.started).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('razorpay_post_resource_notification_failed'));
    errorSpy.mockRestore();
  });
});

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
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

function createAdminSupabaseMock({
  order = { id: 'order-row', buyer_user_id: 'buyer-1', status: 'created' } as BundleOrderRow | null,
  rateLimitAllowed = true,
  completionResult = true,
  completionError = null as { message: string } | null,
  refreshedStatus = 'paid' as BundleOrderRow['status'],
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
                ? { status: refreshedStatus, razorpay_payment_id: 'pay_bundle_123' }
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

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache,
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
  });

  it('treats already paid orders as idempotently processed', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'buyer-1', status: 'paid' },
    });

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

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

    const result = await verifyPostResourceBundlePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'buyer-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      invalidateMarketplaceResourceListCache,
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

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { verifyMarketplacePaymentForRoute } from '@/lib/marketplace-verify-service';

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
} = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as string[],
  };

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table !== 'marketplace_orders') {
        throw new Error(`Unexpected table: ${table}`);
      }

      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        async maybeSingle() {
          if (calls.rpc.some((call) => call.name === 'complete_marketplace_purchase')) {
            return {
              data: order ? { status: refreshedStatus } : null,
              error: null,
            };
          }

          return {
            data: order,
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

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
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
  });

  it('treats an already paid order as idempotently processed', async () => {
    const admin = createAdminSupabaseMock({
      order: { id: 'order-row', buyer_user_id: 'user-1', status: 'paid' },
    });

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
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

    const result = await verifyMarketplacePaymentForRoute({
      adminSupabase: admin.client,
      buyerUserId: 'user-1',
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.tables).toEqual(['marketplace_orders', 'marketplace_orders']);
  });
});

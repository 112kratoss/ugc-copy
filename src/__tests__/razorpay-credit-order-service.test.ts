import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';
import { RazorpayOrderError } from '@/lib/razorpay-orders';
import { createCreditRazorpayOrderForRoute } from '@/lib/razorpay-credit-order-service';

function createAdminSupabaseMock({
  rateLimitAllowed = true,
  transactionError = null as { message: string } | null,
  transactionData = { id: 'txn_123' } as { id: string } | null,
} = {}) {
  const calls = {
    inserts: [] as Array<Record<string, unknown>>,
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };

  const client = {
    from(table: string) {
      if (table !== 'transactions') {
        throw new Error(`Unexpected table: ${table}`);
      }

      return {
        insert(payload: Record<string, unknown>) {
          calls.inserts.push(payload);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: transactionData,
                    error: transactionError,
                  };
                },
              };
            },
          };
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name !== 'check_backend_rate_limit') {
        throw new Error(`Unexpected RPC: ${name}`);
      }

      return Promise.resolve({
        data: {
          allowed: rateLimitAllowed,
          limit: 10,
          remaining: rateLimitAllowed ? 9 : 0,
          retryAfterSeconds: rateLimitAllowed ? 0 : 48,
          resetAt: '2026-06-21T06:30:00.000Z',
        },
        error: null,
      });
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
  };
}

describe('createCreditRazorpayOrderForRoute', () => {
  it('rate limits before creating a Razorpay order or transaction row', async () => {
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });
    const createRazorpayOrder = vi.fn(async () => ({ id: 'order_123' }));

    const result = await createCreditRazorpayOrderForRoute({
      adminSupabase: admin.client,
      userId: 'user_123456789',
      plan: { priceInr: 415, credits: 500 },
      createRazorpayOrder,
      now: () => 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result).toHaveProperty('rateLimitError');
    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(admin.calls.inserts).toEqual([]);
    expect(admin.calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'credit-order:create',
          p_subject_key: 'user_123456789',
          p_limit: 10,
          p_window_seconds: 600,
        },
      },
    ]);
  });

  it('creates a provider order and records the matching credit transaction', async () => {
    const admin = createAdminSupabaseMock();
    const createRazorpayOrder = vi.fn(async () => ({ id: 'order_123' }));

    const result = await createCreditRazorpayOrderForRoute({
      adminSupabase: admin.client,
      userId: 'user_123456789',
      plan: { priceInr: 415, credits: 500 },
      createRazorpayOrder,
      now: () => 123456,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        orderId: 'order_123',
        amount: 41500,
        currency: 'INR',
      },
    });
    expect(createRazorpayOrder).toHaveBeenCalledWith({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      amount: 41500,
      currency: 'INR',
      receipt: 'rcpt_user_123_123456',
    });
    expect(admin.calls.inserts).toEqual([
      {
        user_id: 'user_123456789',
        razorpay_order_id: 'order_123',
        amount: 41500,
        credits: 500,
        status: 'created',
      },
    ]);
  });

  it('returns timeout responses without recording a transaction', async () => {
    const admin = createAdminSupabaseMock();

    const result = await createCreditRazorpayOrderForRoute({
      adminSupabase: admin.client,
      userId: 'user_123456789',
      plan: { priceInr: 415, credits: 500 },
      createRazorpayOrder: vi.fn(async () => {
        throw new ExternalServiceTimeoutError('Razorpay', 30000);
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: 504,
      body: { error: 'Payment provider timed out. Please try again.' },
    });
    expect(admin.calls.inserts).toEqual([]);
  });

  it('maps Razorpay provider errors without recording a transaction', async () => {
    const admin = createAdminSupabaseMock();

    const result = await createCreditRazorpayOrderForRoute({
      adminSupabase: admin.client,
      userId: 'user_123456789',
      plan: { priceInr: 415, credits: 500 },
      createRazorpayOrder: vi.fn(async () => {
        throw new RazorpayOrderError('Unable to create Razorpay order.', 502);
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: 502,
      body: { error: 'Unable to create Razorpay order.' },
    });
    expect(admin.calls.inserts).toEqual([]);
  });

  it('fails if the transaction row cannot be recorded after provider order creation', async () => {
    const admin = createAdminSupabaseMock({
      transactionError: { message: 'insert failed' },
      transactionData: null,
    });

    const result = await createCreditRazorpayOrderForRoute({
      adminSupabase: admin.client,
      userId: 'user_123456789',
      plan: { priceInr: 415, credits: 500 },
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_123' })),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to record transaction' },
    });
    expect(admin.calls.inserts).toHaveLength(1);
  });
});

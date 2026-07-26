import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  verifyCreditRazorpayPaymentForRoute as verifyCreditRazorpayPaymentForRouteImpl,
} from '@/lib/razorpay-credit-verify-service';

type TransactionRow = {
  id: string;
  credits: number;
  status: 'created' | 'success' | 'failed';
};

function signatureFor(orderId: string, paymentId: string, secret = 'test-secret') {
  return crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

function validBody() {
  return {
    razorpay_order_id: 'order_123',
    razorpay_payment_id: 'pay_123',
    razorpay_signature: signatureFor('order_123', 'pay_123'),
    userId: 'user_123',
  };
}

function verifyCreditRazorpayPaymentForRoute(
  input: Parameters<typeof verifyCreditRazorpayPaymentForRouteImpl>[0],
) {
  return verifyCreditRazorpayPaymentForRouteImpl({
    keyId: 'test-key',
    fetchPayment: vi.fn(async ({ paymentId }) => ({
      id: paymentId,
      orderId: 'order_123',
      amount: 15_000,
      amountRefunded: 0,
      currency: 'INR',
      status: 'captured' as const,
      captured: true,
      notes: { user_id: 'user_123' },
    })),
    ...input,
  });
}

function createUserSupabaseMock({
  authUserId = 'user_123',
  authError = null as Error | null,
  transaction = { id: 'txn_123', credits: 500, status: 'created' } as TransactionRow | null,
  transactionError = null as { message: string } | null,
} = {}) {
  const calls = {
    tables: [] as string[],
    filters: [] as Array<[string, unknown]>,
  };

  const client = {
    auth: {
      async getUser() {
        return {
          data: { user: authUserId ? { id: authUserId } : null },
          error: authError,
        };
      },
    },
    from(table: string) {
      calls.tables.push(table);
      if (table !== 'transactions') {
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
        async single() {
          return {
            data: transaction
              ? {
                  user_id: 'user_123',
                  amount: 15_000,
                  razorpay_payment_id: transaction.status === 'success' ? 'pay_123' : null,
                  credit_effect_applied: transaction.status === 'success',
                  ...transaction,
                }
              : null,
            error: transactionError,
          };
        },
      };

      return query;
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
  };
}

function createAdminSupabaseMock({
  rateLimitAllowed = true,
  addCreditsResult = true,
  addCreditsError = null as { message: string } | null,
  referralError = null as { message: string } | null,
  onAddCredits = undefined as (() => void) | undefined,
} = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name === 'check_backend_rate_limit') {
        return Promise.resolve({
          data: {
            allowed: rateLimitAllowed,
            limit: 30,
            remaining: rateLimitAllowed ? 29 : 0,
            retryAfterSeconds: rateLimitAllowed ? 0 : 41,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        });
      }

      if (name === 'add_credits') {
        onAddCredits?.();
        return Promise.resolve({
          data: addCreditsResult,
          error: addCreditsError,
        });
      }

      if (name === 'settle_referral_purchase_rewards') {
        return Promise.resolve({
          data: referralError ? null : { status: 'not_referred', rewards: [] },
          error: referralError,
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

describe('verifyCreditRazorpayPaymentForRoute', () => {
  it('rejects malformed payloads before creating Supabase clients', async () => {
    const createUserSupabase = vi.fn();
    const createAdminSupabase = vi.fn();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => ({})),
      createUserSupabase,
      createAdminSupabase,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Missing required parameters' },
    });
    expect(createUserSupabase).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures before creating Supabase clients', async () => {
    const createUserSupabase = vi.fn();
    const createAdminSupabase = vi.fn();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => ({
        ...validBody(),
        razorpay_signature: 'bad-signature',
      })),
      createUserSupabase,
      createAdminSupabase,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid payment signature' },
    });
    expect(createUserSupabase).not.toHaveBeenCalled();
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rejects authentication mismatches before creating an admin client', async () => {
    const user = createUserSupabaseMock({ authUserId: 'other-user' });
    const createAdminSupabase = vi.fn();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase,
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
    expect(user.calls.tables).toEqual([]);
  });

  it('rate limits verified credit payments before transaction lookup or credit mutation', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result).toHaveProperty('rateLimitError');
    expect(user.calls.tables).toEqual([]);
    expect(admin.calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'credit-order:verify',
          p_subject_key: 'user_123',
          p_limit: 30,
          p_window_seconds: 600,
        },
      },
    ]);
  });

  it('assigns credits after signature, ownership, and transaction checks pass', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(user.calls.tables).toEqual(['transactions']);
    expect(user.calls.filters).toEqual([
      ['razorpay_order_id', 'order_123'],
      ['user_id', 'user_123'],
    ]);
    expect(admin.calls.rpc).toContainEqual({
      name: 'add_credits',
      args: {
        p_user_id: 'user_123',
        p_credits: 500,
        p_transaction_id: 'txn_123',
        p_payment_id: 'pay_123',
      },
    });
  });

  it('treats already successful transactions as idempotently processed', async () => {
    const user = createUserSupabaseMock({
      transaction: { id: 'txn_123', credits: 500, status: 'success' },
    });
    const admin = createAdminSupabaseMock();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual([
      'check_backend_rate_limit',
      'settle_referral_purchase_rewards',
    ]);
  });

  it('returns not found when the credit transaction is missing', async () => {
    const user = createUserSupabaseMock({
      transaction: null,
      transactionError: { message: 'not found' },
    });
    const admin = createAdminSupabaseMock();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Transaction not found' },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('maps add_credits failures to a stable settlement error', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock({
      addCreditsResult: false,
      addCreditsError: { message: 'rpc failed' },
    });

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to assign credits' },
    });
    expect(admin.calls.rpc).toContainEqual({
      name: 'add_credits',
      args: {
        p_user_id: 'user_123',
        p_credits: 500,
        p_transaction_id: 'txn_123',
        p_payment_id: 'pay_123',
      },
    });
  });

  it('keeps a verified top-up successful when referral settlement is temporarily unavailable', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock({
      referralError: { message: 'referral database unavailable' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(admin.calls.rpc.map((call) => call.name)).toContain('settle_referral_purchase_rewards');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('credit_purchase_referral_settlement_deferred'));
    errorSpy.mockRestore();
  });

  it('treats a concurrent webhook credit assignment as an idempotent success', async () => {
    const transaction: TransactionRow = { id: 'txn_123', credits: 500, status: 'created' };
    const user = createUserSupabaseMock({ transaction });
    const admin = createAdminSupabaseMock({
      addCreditsResult: false,
      onAddCredits: () => {
        transaction.status = 'success';
      },
    });

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(user.calls.tables).toEqual(['transactions', 'transactions']);
    expect(admin.calls.rpc.map((call) => call.name)).toEqual([
      'check_backend_rate_limit',
      'add_credits',
      'settle_referral_purchase_rewards',
    ]);
  });

  it('returns 202 without granting credits while the provider payment is authorized', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_123',
        orderId: 'order_123',
        amount: 15_000,
        amountRefunded: 0,
        currency: 'INR',
        status: 'authorized' as const,
        captured: false,
        notes: { user_id: 'user_123' },
      })),
    });

    expect(result).toEqual({
      ok: true,
      status: 202,
      body: expect.objectContaining({
        success: false,
        status: 'pending',
        pending: true,
        code: 'PAYMENT_PENDING',
      }),
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
  });

  it('rejects a captured provider payment whose amount differs from the transaction', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      fetchPayment: vi.fn(async () => ({
        id: 'pay_123',
        orderId: 'order_123',
        amount: 1,
        amountRefunded: 0,
        currency: 'INR',
        status: 'captured' as const,
        captured: true,
        notes: { user_id: 'user_123' },
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

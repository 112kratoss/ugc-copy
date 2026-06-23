import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { verifyCreditRazorpayPaymentForRoute } from '@/lib/razorpay-credit-verify-service';

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
            data: transaction,
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
        return Promise.resolve({
          data: addCreditsResult,
          error: addCreditsError,
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
    expect(admin.calls.rpc.map((call) => call.name)).toEqual(['check_backend_rate_limit']);
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
});

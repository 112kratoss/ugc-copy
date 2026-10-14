import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import {
  notifyRazorpayCreditPurchase,
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
  referralSettlement = { status: 'not_referred', rewards: [] } as Record<string, unknown>,
  onAddCredits = undefined as (() => void) | undefined,
  /** The buyer's balance once the top-up and any referral bonus are in. */
  balance = 1_005,
} = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    tables: [] as string[],
  };

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table !== 'profiles') {
        throw new Error(`Unexpected table: ${table}`);
      }
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { credits: balance }, error: null }),
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
          data: referralError ? null : referralSettlement,
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
    const notifyCreditPurchase = vi.fn(async () => null);

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      notifyCreditPurchase,
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
    // This verify settled the top-up, so the buyer is told from here, once.
    expect(notifyCreditPurchase).toHaveBeenCalledTimes(1);
    expect(notifyCreditPurchase).toHaveBeenCalledWith(admin.client, { userId: 'user_123', transactionId: 'txn_123' });
  });

  it('treats already successful transactions as idempotently processed', async () => {
    const user = createUserSupabaseMock({
      transaction: { id: 'txn_123', credits: 500, status: 'success' },
    });
    const admin = createAdminSupabaseMock();
    const notifyCreditPurchase = vi.fn();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      notifyCreditPurchase,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyProcessed: true },
    });
    expect(admin.calls.rpc.map((call) => call.name)).toEqual([
      'check_backend_rate_limit',
      'settle_referral_purchase_rewards',
    ]);
    // Whoever settled it first told the buyer.
    expect(notifyCreditPurchase).not.toHaveBeenCalled();
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
    const notifyCreditPurchase = vi.fn(async () => null);

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      notifyCreditPurchase,
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(admin.calls.rpc.map((call) => call.name)).toContain('settle_referral_purchase_rewards');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('credit_purchase_referral_settlement_deferred'));
    // The top-up itself is still announced.
    expect(notifyCreditPurchase).toHaveBeenCalledTimes(1);
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
    const notifyCreditPurchase = vi.fn();

    const result = await verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => admin.client),
      notifyCreditPurchase,
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
    // The webhook settled it, and it tells the buyer.
    expect(notifyCreditPurchase).not.toHaveBeenCalled();
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

describe('credit verify referral notifications', () => {
  // The real notifier runs here against held notification history. A referred
  // buyer's first top-up earns two rewards, and each person is told of theirs.
  const referredFirstPurchase = {
    status: 'settled',
    rewards: [
      {
        id: 'reward-inviter',
        user_id: 'inviter_123',
        event_key: 'grant:inviter',
        kind: 'inviter_purchase',
        status: 'granted',
        credits: 5,
        active_credits: 5,
      },
      {
        id: 'reward-invitee',
        user_id: 'user_123',
        event_key: 'grant:invitee',
        kind: 'invitee_first_purchase',
        status: 'granted',
        credits: 5,
        active_credits: 5,
      },
    ],
  };
  const rewardKeys = [
    'referral-reward:reward-inviter:grant:inviter',
    'referral-reward:reward-invitee:grant:invitee',
  ];
  const rewardNotifications = [
    expect.objectContaining({ user_id: 'inviter_123', type: 'referral_reward_earned', dedupe_key: rewardKeys[0] }),
    expect.objectContaining({ user_id: 'user_123', type: 'referral_reward_earned', dedupe_key: rewardKeys[1] }),
  ];
  // "Credits added" for a top-up this verify settled, worded as one bought in
  // the app: the balance it left, the bonus included.
  const creditAlert = expect.objectContaining({
    user_id: 'user_123',
    type: 'credits_purchased',
    category: 'commerce',
    body: 'Your balance is now 1,005 credits.',
    deep_link: '/profile',
    dedupe_key: 'credits:txn_123',
  });

  // The three ways a verified top-up reaches the referral settlement. Each has
  // the buyer waiting on the checkout's answer. Only the verify that settled
  // the top-up announces it; the rewards are announced every time, as before.
  const referredVerifications = [
    {
      kind: 'a fresh payment',
      setUp: () => ({
        user: createUserSupabaseMock(),
        admin: createAdminSupabaseMock({ referralSettlement: referredFirstPurchase }),
      }),
      body: { success: true, referralBonusCredits: 5 },
      deferredTasks: 2,
      alerts: [...rewardNotifications, creditAlert],
    },
    {
      kind: 'a payment that was already settled',
      setUp: () => ({
        user: createUserSupabaseMock({ transaction: { id: 'txn_123', credits: 500, status: 'success' } }),
        admin: createAdminSupabaseMock({ referralSettlement: referredFirstPurchase }),
      }),
      body: { success: true, alreadyProcessed: true, referralBonusCredits: 5 },
      deferredTasks: 1,
      alerts: rewardNotifications,
    },
    {
      kind: 'a payment the webhook settles at the same moment',
      setUp: () => {
        const transaction: TransactionRow = { id: 'txn_123', credits: 500, status: 'created' };
        return {
          user: createUserSupabaseMock({ transaction }),
          admin: createAdminSupabaseMock({
            referralSettlement: referredFirstPurchase,
            addCreditsResult: false,
            onAddCredits: () => {
              transaction.status = 'success';
            },
          }),
        };
      },
      body: { success: true, alreadyProcessed: true, referralBonusCredits: 5 },
      deferredTasks: 1,
      alerts: rewardNotifications,
    },
  ];

  it.each(referredVerifications)(
    'answers $kind before the referral rewards are announced when the caller can run work after the response',
    async ({ setUp, body, deferredTasks, alerts }) => {
      const { user, admin } = setUp();
      const history = createMobileNotificationHistory();
      history.hold();
      const deferred: Array<() => Promise<unknown>> = [];

      const verification = verifyCreditRazorpayPaymentForRoute({
        keySecret: 'test-secret',
        readBody: vi.fn(async () => validBody()),
        createUserSupabase: vi.fn(() => user.client),
        createAdminSupabase: vi.fn(() => withMobileNotificationHistory(admin.client, history)),
        runAfterResponse: (task) => { deferred.push(task); },
      });

      // A notification that has not finished no longer holds the checkout's
      // answer back, and the bonus that answer reports is the one it always was.
      expect(await hasAnswered(verification)).toBe(true);
      await expect(verification).resolves.toEqual({ ok: true, body });
      expect(history.started).toEqual([]);
      expect(deferred).toHaveLength(deferredTasks);

      history.release();
      for (const task of deferred) await task();
      expect(history.sent).toEqual(alerts);
    },
  );

  it.each(referredVerifications)(
    'announces the referral rewards before answering $kind when the caller has nowhere to run them afterwards',
    async ({ setUp, body, alerts }) => {
      const { user, admin } = setUp();
      const history = createMobileNotificationHistory();
      history.hold();

      const verification = verifyCreditRazorpayPaymentForRoute({
        keySecret: 'test-secret',
        readBody: vi.fn(async () => validBody()),
        createUserSupabase: vi.fn(() => user.client),
        createAdminSupabase: vi.fn(() => withMobileNotificationHistory(admin.client, history)),
      });

      expect(await hasAnswered(verification)).toBe(false);
      expect(history.started).toEqual(rewardKeys);

      history.release();
      await expect(verification).resolves.toEqual({ ok: true, body });
      expect(history.sent).toEqual(alerts);
    },
  );

  it("announces a referred buyer's rewards and then the balance, in that order, when after() starts both at once", async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock({ referralSettlement: referredFirstPurchase });
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    await expect(verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => withMobileNotificationHistory(admin.client, history)),
      runAfterResponse: (task) => { deferred.push(task); },
    })).resolves.toEqual({ ok: true, body: { success: true, referralBonusCredits: 5 } });

    // Next's after() starts everything it was handed at once. "Credits added"
    // still waits for the rewards, as it does in the app.
    const sending = Promise.all(deferred.map((task) => task()));
    expect(await hasAnswered(sending)).toBe(false);
    expect(history.started).toEqual(rewardKeys);

    history.release();
    await sending;
    expect(history.sent).toEqual([...rewardNotifications, creditAlert]);
  });

  it('defers only the balance for a buyer who was not referred', async () => {
    const user = createUserSupabaseMock();
    const admin = createAdminSupabaseMock();
    const history = createMobileNotificationHistory();
    const deferred: Array<() => Promise<unknown>> = [];

    await expect(verifyCreditRazorpayPaymentForRoute({
      keySecret: 'test-secret',
      readBody: vi.fn(async () => validBody()),
      createUserSupabase: vi.fn(() => user.client),
      createAdminSupabase: vi.fn(() => withMobileNotificationHistory(admin.client, history)),
      runAfterResponse: (task) => { deferred.push(task); },
    })).resolves.toEqual({ ok: true, body: { success: true } });

    expect(deferred).toHaveLength(1);
    expect(history.started).toEqual([]);

    await deferred[0]();
    expect(history.sent).toEqual([creditAlert]);
  });
});

describe('notifyRazorpayCreditPurchase', () => {
  it('says the balance the top-up left, as a top-up in the app does', async () => {
    const admin = createAdminSupabaseMock({ balance: 12_500 });
    const history = createMobileNotificationHistory();

    await notifyRazorpayCreditPurchase(withMobileNotificationHistory(admin.client, history), {
      userId: 'user_123',
      transactionId: 'txn_123',
    });

    expect(admin.calls.tables).toEqual(['profiles']);
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user_123',
      type: 'credits_purchased',
      category: 'commerce',
      title: 'Credits added',
      body: 'Your balance is now 12,500 credits.',
      deep_link: '/profile',
      object_type: 'credits',
      object_id: 'txn_123',
      dedupe_key: 'credits:txn_123',
    })]);
  });

  it('still announces the top-up when the balance cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const history = createMobileNotificationHistory();
    const unreadable = {
      from: () => {
        throw new Error('profiles unavailable');
      },
    } as unknown as SupabaseClient;

    await notifyRazorpayCreditPurchase(withMobileNotificationHistory(unreadable, history), {
      userId: 'user_123',
      transactionId: 'txn_123',
    });

    expect(history.sent).toEqual([expect.objectContaining({
      body: 'Your credit purchase is complete.',
      dedupe_key: 'credits:txn_123',
    })]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('razorpay_credit_notification_balance_unread'));
    errorSpy.mockRestore();
  });
});

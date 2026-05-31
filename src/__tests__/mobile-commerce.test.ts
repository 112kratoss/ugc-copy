import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  MobileCommerceError,
  buildMobileExternalOrderId,
  completeMobileCreditPurchase,
  normalizeMobileCommercePayload,
  restoreMobileEntitlements,
  verifyMobilePurchase,
} from '@/lib/mobile-commerce';

const userId = '11111111-1111-1111-1111-111111111111';

function createCreditSupabase(options: {
  credits?: number;
  duplicateInsertForOrderId?: string;
  transactions?: Array<{
    id: string;
    user_id: string;
    razorpay_order_id: string;
    credits: number;
    status: string;
  }>;
} = {}) {
  let credits = options.credits ?? 100;
  const transactions = [...(options.transactions ?? [])];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  return {
    client: {
      from(table: string) {
        if (table === 'profiles') {
          return {
            select() {
              return {
                eq(_column: string, value: string) {
                  return {
                    async maybeSingle() {
                      return value === userId
                        ? { data: { credits }, error: null }
                        : { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'transactions') {
          const filters: Record<string, unknown> = {};
          const query = {
            select() {
              return query;
            },
            eq(column: string, value: unknown) {
              filters[column] = value;
              return query;
            },
            async maybeSingle() {
              const match =
                transactions.find((transaction) =>
                  Object.entries(filters).every(([key, value]) => (transaction as Record<string, unknown>)[key] === value)
                ) ?? null;
              return { data: match, error: null };
            },
          };

          return {
            ...query,
            insert(values: Record<string, unknown>) {
              const transaction = {
                id: `txn-mobile-${transactions.length + 1}`,
                user_id: values.user_id as string,
                razorpay_order_id: values.razorpay_order_id as string,
                credits: values.credits as number,
                status: values.status as string,
              };
              if (options.duplicateInsertForOrderId === transaction.razorpay_order_id) {
                transactions.push(transaction);
                return {
                  select() {
                    return {
                      async single() {
                        return {
                          data: null,
                          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                        };
                      },
                    };
                  },
                };
              }
              transactions.push(transaction);
              return {
                select() {
                  return {
                    async single() {
                      return { data: transaction, error: null };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'marketplace_purchases') {
          return {
            select() {
              return {
                eq() {
                  return { data: [], error: null };
                },
              };
            },
          };
        }

        if (table === 'post_resource_bundle_purchases') {
          return {
            select() {
              return {
                eq() {
                  return { data: [], error: null };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        const transaction = transactions.find((item) => item.id === args.p_transaction_id);
        if (name === 'add_credits' && transaction?.status === 'created') {
          transaction.status = 'success';
          credits += Number(args.p_credits ?? 0);
          return { data: true, error: null };
        }

        return { data: false, error: null };
      },
    } as unknown as SupabaseClient,
    get credits() {
      return credits;
    },
    transactions,
    rpcCalls,
  };
}

describe('mobile commerce helpers', () => {
  it('normalizes credit purchase payloads', () => {
    expect(normalizeMobileCommercePayload({
      provider: 'app_store',
      productId: 'magicbooklet.credits.starter',
      entitlement: {
        type: 'credits',
        productId: 'magicbooklet.credits.starter',
      },
    })).toMatchObject({
      provider: 'app_store',
      productId: 'magicbooklet.credits.starter',
      entitlement: {
        type: 'credits',
      },
    });
  });

  it('rejects mismatched entitlements', () => {
    expect(() => normalizeMobileCommercePayload({
      provider: 'play_store',
      productId: 'magicbooklet.credits.starter',
      entitlement: {
        type: 'credits',
        productId: 'magicbooklet.credits.pro',
      },
    })).toThrow(MobileCommerceError);
  });

  it('verifies RevenueCat non-subscription purchases', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              id: 'rc-1',
              store: 'app_store',
              store_transaction_id: '1000000123456789',
              purchase_date: '2026-05-12T12:00:00Z',
            },
          ],
        },
      },
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.creator',
      provider: 'app_store',
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).resolves.toMatchObject({
      provider: 'app_store',
      transactionId: '1000000123456789',
    });
  });

  it('rejects invalid RevenueCat receipts', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {},
      },
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.creator',
      provider: 'play_store',
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects RevenueCat purchases without a stable transaction identifier', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              store: 'app_store',
            },
          ],
        },
      },
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.creator',
      provider: 'app_store',
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('completes credit purchases once and returns the updated balance', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });

    await expect(completeMobileCreditPurchase({
      adminSupabase: fakeSupabase.client,
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'app_store',
      transactionId: '1000000123456789',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'credits',
      credits: 600,
      alreadyProcessed: false,
    });
    expect(fakeSupabase.rpcCalls).toHaveLength(1);
    expect(fakeSupabase.transactions[0]?.razorpay_order_id).toBe(buildMobileExternalOrderId('app_store', '1000000123456789'));
  });

  it('does not double-credit an already completed mobile transaction', async () => {
    const externalOrderId = buildMobileExternalOrderId('app_store', '1000000123456789');
    const fakeSupabase = createCreditSupabase({
      credits: 600,
      transactions: [{
        id: 'txn-existing',
        user_id: userId,
        razorpay_order_id: externalOrderId,
        credits: 500,
        status: 'success',
      }],
    });

    await expect(completeMobileCreditPurchase({
      adminSupabase: fakeSupabase.client,
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'app_store',
      transactionId: '1000000123456789',
    })).resolves.toMatchObject({
      credits: 600,
      alreadyProcessed: true,
    });
    expect(fakeSupabase.rpcCalls).toHaveLength(0);
  });

  it('recovers when a duplicate mobile transaction insert already created the order', async () => {
    const externalOrderId = buildMobileExternalOrderId('app_store', '1000000123456790');
    const fakeSupabase = createCreditSupabase({
      credits: 100,
      duplicateInsertForOrderId: externalOrderId,
    });

    await expect(completeMobileCreditPurchase({
      adminSupabase: fakeSupabase.client,
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'app_store',
      transactionId: '1000000123456790',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'credits',
      credits: 600,
      alreadyProcessed: false,
    });
    expect(fakeSupabase.transactions).toHaveLength(1);
    expect(fakeSupabase.rpcCalls).toHaveLength(1);
  });

  it('restores unprocessed RevenueCat credit purchases and reports already processed purchases', async () => {
    const existingExternalOrderId = buildMobileExternalOrderId('app_store', '1000000123456791');
    const fakeSupabase = createCreditSupabase({
      credits: 600,
      transactions: [{
        id: 'txn-existing',
        user_id: userId,
        razorpay_order_id: existingExternalOrderId,
        credits: 500,
        status: 'success',
      }],
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.starter': [
            {
              id: 'rc-new',
              store: 'app_store',
              store_transaction_id: '1000000123456792',
              purchase_date: '2026-05-13T12:00:00Z',
            },
            {
              id: 'rc-existing',
              store: 'app_store',
              store_transaction_id: '1000000123456791',
              purchase_date: '2026-05-12T12:00:00Z',
            },
          ],
          'magicbooklet.credits.pro': [
            {
              id: 'rc-refunded',
              store: 'play_store',
              store_transaction_id: 'GPA.1234',
              purchase_date: '2026-05-11T12:00:00Z',
              refunded_at: '2026-05-12T12:00:00Z',
            },
          ],
          'magicbooklet.unlock.asset-1': [
            {
              id: 'rc-unknown',
              store: 'app_store',
              store_transaction_id: 'unknown-1',
              purchase_date: '2026-05-10T12:00:00Z',
            },
          ],
        },
      },
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }));

    await expect(restoreMobileEntitlements(fakeSupabase.client, userId, {
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).resolves.toMatchObject({
      success: true,
      credits: 1100,
      restoredCreditPurchases: 1,
      alreadyProcessedCreditPurchases: 1,
      entitlements: expect.arrayContaining([
        expect.objectContaining({ entitlement: 'credits', alreadyProcessed: false }),
        expect.objectContaining({ entitlement: 'credits', alreadyProcessed: true }),
      ]),
    });
    expect(fakeSupabase.transactions).toHaveLength(2);
  });

  it('fails restore reconciliation clearly when RevenueCat verification is not configured', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });

    await expect(restoreMobileEntitlements(fakeSupabase.client, userId, {
      revenueCatApiKey: '',
    })).rejects.toMatchObject({
      status: 500,
      message: 'Mobile receipt verification is not configured.',
    });
  });
});

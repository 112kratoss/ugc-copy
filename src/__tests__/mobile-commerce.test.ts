import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MobileCommerceError,
  buildMobileExternalOrderId,
  completeMobileCreditPurchase,
  completeMobileMarketplaceUnlock,
  completeMobilePurchase,
  completeMobilePostResourceUnlock,
  createMobilePurchaseIntent,
  normalizeMobileCommercePayload,
  resolveMobileCreditProduct,
  restoreMobileEntitlements,
  verifyMobilePurchase,
} from '@/lib/mobile-commerce';
import { EXTERNAL_API_REQUEST_TIMEOUT_MS } from '@/lib/provider-fetch';

const userId = '11111111-1111-1111-1111-111111111111';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
        if (name === 'complete_mobile_purchase') {
          const productId = String(args.p_product_id);
          const plan = {
            'magicbooklet.credits.starter': { amount: 41500, credits: 500 },
            'magicbooklet.credits.creator': { amount: 166000, credits: 2000 },
            'magicbooklet.credits.pro': { amount: 830000, credits: 10000 },
          }[productId];
          if (!plan) return { data: { status: 'product_not_found' }, error: null };
          const externalOrderId = String(args.p_external_order_id);
          let transaction = transactions.find((item) => item.razorpay_order_id === externalOrderId);
          if (transaction?.status === 'refunded') {
            return { data: { status: 'revoked' }, error: null };
          }
          const alreadyProcessed = transaction?.status === 'success';
          if (!transaction) {
            transaction = {
              id: `txn-mobile-${transactions.length + 1}`,
              user_id: String(args.p_user_id),
              razorpay_order_id: externalOrderId,
              credits: plan.credits,
              status: 'success',
            };
            transactions.push(transaction);
            credits += plan.credits;
          }
          return {
            data: {
              status: alreadyProcessed ? 'already_processed' : 'completed',
              entitlement_type: 'credits',
              product_id: productId,
              resource_id: null,
              amount_subunits: plan.amount,
              currency: 'INR',
              credits: plan.credits,
              remaining_credits: credits,
              source_record_id: transaction.id,
            },
            error: null,
          };
        }
        if (name === 'settle_referral_purchase_rewards') {
          return { data: { status: 'not_referred', rewards: [] }, error: null };
        }
        if (name === 'reconcile_mobile_credit_purchase_adjustment') {
          const restored = transactions.find((item) => item.razorpay_order_id === args.p_external_order_id);
          if (restored?.status === 'refunded' && args.p_action === 'restore') {
            restored.status = 'success';
            credits += restored.credits;
            return { data: { status: 'restored', rewards: [] }, error: null };
          }
          return { data: { status: 'already_active', rewards: [] }, error: null };
        }
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

function createNotificationOnlyFromMock(disallowedTables: string[]) {
  let notificationId = 0;

  return vi.fn((table: string) => {
    if (table === 'mobile_notifications') {
      return {
        select() {
          return {
            eq() {
              return this;
            },
            async maybeSingle() {
              return { data: null, error: null };
            },
          };
        },
        insert(values: Record<string, unknown>) {
          notificationId += 1;
          return {
            select() {
              return {
                async single() {
                  return {
                    data: {
                      id: `notification-${notificationId}`,
                      ...values,
                      event_count: 1,
                      is_read: false,
                      created_at: '2026-06-21T00:00:00.000Z',
                      updated_at: '2026-06-21T00:00:00.000Z',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    }

    if (table === 'mobile_notification_preferences') {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return {
                    data: {
                      push_enabled: false,
                      generation_enabled: true,
                      commerce_enabled: true,
                      social_enabled: true,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    }

    disallowedTables.push(table);
    throw new Error(`Unexpected client-side mobile cash unlock table step: ${table}`);
  });
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
      purchaseIntentId: null,
    });
  });

  it('ignores client-selected entitlement authority for fixed credit SKUs', () => {
    expect(normalizeMobileCommercePayload({
      provider: 'play_store',
      productId: 'magicbooklet.credits.starter',
      entitlement: {
        type: 'marketplace_unlock',
        productId: 'attacker-controlled-product',
        assetId: 'attacker-controlled-asset',
      },
    })).toMatchObject({
      productId: 'magicbooklet.credits.starter',
      purchaseIntentId: null,
    });
  });

  it('does not resolve prototype-chain product ids as credit products', () => {
    expect(resolveMobileCreditProduct('constructor')).toBeNull();
    expect(resolveMobileCreditProduct('__proto__')).toBeNull();
    expect(resolveMobileCreditProduct('toString')).toBeNull();
    expect(resolveMobileCreditProduct('magicbooklet.credits.starter')).toMatchObject({
      id: 'starter',
      credits: 500,
    });
  });

  it('requires an opaque server intent for non-credit products', () => {
    expect(() => normalizeMobileCommercePayload({
      provider: 'play_store',
      productId: 'magicbooklet.unlock.tier-900',
      entitlement: { type: 'marketplace_unlock', assetId: 'asset-attacker' },
    })).toThrow(MobileCommerceError);

    expect(normalizeMobileCommercePayload({
      provider: 'play_store',
      productId: 'magicbooklet.unlock.tier-900',
      purchaseIntentId: '11111111-2222-4333-8444-555555555555',
    })).toMatchObject({
      purchaseIntentId: '11111111-2222-4333-8444-555555555555',
    });
  });

  it('fails closed when a resource price tier has no provisioned store product', async () => {
    const rpc = vi.fn(async () => ({
      data: { status: 'product_not_configured' },
      error: null,
    }));

    await expect(createMobilePurchaseIntent({
      adminSupabase: { rpc } as unknown as SupabaseClient,
      userId,
      entitlementType: 'marketplace_unlock',
      resourceId: 'asset-1',
    })).rejects.toMatchObject({
      status: 409,
      message: 'No mobile store product is configured for this resource.',
    });
    expect(rpc).toHaveBeenCalledWith('create_mobile_purchase_intent', {
      p_user_id: userId,
      p_entitlement_type: 'marketplace_unlock',
      p_resource_id: 'asset-1',
    });
  });

  it('keeps post resource packages credit-only on mobile', async () => {
    const rpc = vi.fn();

    await expect(createMobilePurchaseIntent({
      adminSupabase: { rpc } as unknown as SupabaseClient,
      userId,
      entitlementType: 'post_resource_unlock',
      resourceId: 'post-1',
    })).rejects.toMatchObject({
      status: 400,
      message: 'Post resources are credit-only on mobile. Use the credit unlock option.',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns only the server-selected product and immutable intent quote', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'created',
        purchase_intent_id: 'intent-marketplace-1',
        product_id: 'magicbooklet.marketplace.usd900',
        amount_subunits: 900,
        currency: 'USD',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      error: null,
    }));

    await expect(createMobilePurchaseIntent({
      adminSupabase: { rpc } as unknown as SupabaseClient,
      userId,
      entitlementType: 'marketplace_unlock',
      resourceId: 'asset-1',
    })).resolves.toEqual({
      purchaseIntentId: 'intent-marketplace-1',
      productId: 'magicbooklet.marketplace.usd900',
      amountSubunits: 900,
      currency: 'USD',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('verifies RevenueCat non-subscription purchases', async () => {
    const timeoutSignal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
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
    expect(timeoutSpy).toHaveBeenCalledWith(EXTERNAL_API_REQUEST_TIMEOUT_MS);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.revenuecat.com/v1/subscribers/11111111-1111-1111-1111-111111111111',
      expect.objectContaining({
        signal: timeoutSignal,
      })
    );
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

  it('returns a retryable timeout error when RevenueCat verification stalls', async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.creator',
      provider: 'app_store',
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).rejects.toMatchObject({
      status: 504,
      message: 'Mobile purchase verification timed out.',
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

  it('rejects sandbox RevenueCat receipts so TestFlight purchases never grant real credits', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              id: 'rc-sandbox-1',
              store: 'app_store',
              store_transaction_id: '2000000123456789',
              purchase_date: '2026-05-12T12:00:00Z',
              is_sandbox: true,
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
      message: 'Mobile purchase receipt is invalid or not owned by this user.',
    });
  });

  it('verifies sandbox receipts when MOBILE_COMMERCE_ALLOW_SANDBOX=1 is set for staging QA', async () => {
    vi.stubEnv('MOBILE_COMMERCE_ALLOW_SANDBOX', '1');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              id: 'rc-sandbox-1',
              store: 'app_store',
              store_transaction_id: '2000000123456789',
              purchase_date: '2026-05-12T12:00:00Z',
              is_sandbox: true,
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
      transactionId: '2000000123456789',
    });
  });

  it('still verifies the production purchase when a sandbox sibling shares the product', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              id: 'rc-sandbox-1',
              store: 'app_store',
              store_transaction_id: '2000000123456789',
              purchase_date: '2026-05-14T12:00:00Z',
              is_sandbox: true,
            },
            {
              id: 'rc-production-1',
              store: 'app_store',
              store_transaction_id: '1000000123456789',
              purchase_date: '2026-05-12T12:00:00Z',
              is_sandbox: false,
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

  it('rejects client-declared sandbox purchases without the explicit server opt-in', async () => {
    const fetcher = vi.fn();

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'sandbox',
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
      nodeEnv: 'development',
    })).rejects.toMatchObject({
      status: 400,
      message: 'Sandbox mobile purchases require an explicit server opt-in.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps client-declared sandbox purchases disabled in production even with the opt-in', async () => {
    vi.stubEnv('MOBILE_COMMERCE_ALLOW_SANDBOX', '1');

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'sandbox',
      revenueCatApiKey: 'rc-secret',
      nodeEnv: 'production',
    })).rejects.toMatchObject({
      status: 400,
      message: 'Sandbox mobile purchases are disabled in production.',
    });
  });

  it('allows client-declared sandbox purchases outside production only with the opt-in', async () => {
    vi.stubEnv('MOBILE_COMMERCE_ALLOW_SANDBOX', '1');

    await expect(verifyMobilePurchase({
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'sandbox',
      revenueCatApiKey: 'rc-secret',
      nodeEnv: 'development',
    })).resolves.toMatchObject({
      provider: 'sandbox',
      transactionId: 'sandbox_magicbooklet.credits.starter',
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
    expect(fakeSupabase.rpcCalls.map((call) => call.name)).toEqual([
      'complete_mobile_purchase',
      'settle_referral_purchase_rewards',
    ]);
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
    expect(fakeSupabase.rpcCalls.map((call) => call.name)).toEqual([
      'complete_mobile_purchase',
      'settle_referral_purchase_rewards',
    ]);
  });

  it('does not silently reactivate a store transaction that was explicitly revoked', async () => {
    const externalOrderId = buildMobileExternalOrderId('app_store', '1000000123456789');
    const fakeSupabase = createCreditSupabase({
      credits: 100,
      transactions: [{
        id: 'txn-refunded',
        user_id: userId,
        razorpay_order_id: externalOrderId,
        credits: 500,
        status: 'refunded',
      }],
    });

    await expect(completeMobileCreditPurchase({
      adminSupabase: fakeSupabase.client,
      userId,
      productId: 'magicbooklet.credits.starter',
      provider: 'app_store',
      transactionId: '1000000123456789',
    })).rejects.toMatchObject({
      status: 409,
      message: 'This mobile store transaction has been revoked.',
    });
    expect(fakeSupabase.credits).toBe(100);
  });

  it('settles credit purchases only through the global atomic purchase RPC', async () => {
    const externalOrderId = buildMobileExternalOrderId('app_store', '1000000123456790');
    const fakeSupabase = createCreditSupabase({
      credits: 100,
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
    expect(fakeSupabase.rpcCalls.map((call) => call.name)).toEqual([
      'complete_mobile_purchase',
      'settle_referral_purchase_rewards',
    ]);
    expect(fakeSupabase.rpcCalls[0]).toMatchObject({
      args: {
        p_purchase_intent_id: null,
        p_external_order_id: externalOrderId,
      },
    });
  });

  it('uses one atomic database call for mobile marketplace cash unlocks', async () => {
    const disallowedTables: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('complete_mobile_purchase');
      expect(args).toEqual({
        p_user_id: userId,
        p_purchase_intent_id: 'intent-marketplace-1',
        p_product_id: 'magicbooklet.marketplace.usd900',
        p_provider: 'app_store',
        p_store_transaction_id: '1000000123456800',
        p_external_order_id: buildMobileExternalOrderId('app_store', '1000000123456800'),
        p_payment_id: 'mobile_app_store_1000000123456800',
      });
      return {
        data: {
          status: 'completed',
          entitlement_type: 'marketplace_unlock',
          product_id: 'magicbooklet.marketplace.usd900',
          resource_id: 'asset-1',
          amount_subunits: 900,
          currency: 'USD',
          seller_user_id: 'seller-1',
        },
        error: null,
      };
    });
    const notificationFrom = createNotificationOnlyFromMock(disallowedTables);
    const from = vi.fn((table: string) => {
      if (table === 'mobile_purchase_intents') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                id: 'intent-marketplace-1',
                user_id: userId,
                product_id: 'magicbooklet.marketplace.usd900',
                entitlement_type: 'marketplace_unlock',
                resource_id: 'asset-1',
                amount_subunits: 900,
                currency: 'USD',
                credits: null,
                status: 'pending',
                expires_at: '2099-01-01T00:00:00.000Z',
              },
              error: null,
            };
          },
        };
        return query;
      }
      return notificationFrom(table);
    });

    await expect(completeMobileMarketplaceUnlock({
      adminSupabase: { rpc, from } as unknown as SupabaseClient,
      userId,
      purchaseIntentId: 'intent-marketplace-1',
      productId: 'magicbooklet.marketplace.usd900',
      provider: 'app_store',
      transactionId: '1000000123456800',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
      alreadyProcessed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(disallowedTables).toEqual([]);
  });

  it('treats replayed mobile marketplace cash unlocks as already processed', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'already_processed',
        entitlement_type: 'marketplace_unlock',
        product_id: 'magicbooklet.marketplace.usd900',
        resource_id: 'asset-1',
        amount_subunits: 900,
        currency: 'USD',
        seller_user_id: 'seller-1',
      },
      error: null,
    }));
    const from = vi.fn(() => {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          return {
            data: {
              id: 'intent-marketplace-1',
              user_id: userId,
              product_id: 'magicbooklet.marketplace.usd900',
              entitlement_type: 'marketplace_unlock',
              resource_id: 'asset-1',
              amount_subunits: 900,
              currency: 'USD',
              credits: null,
              status: 'consumed',
              expires_at: '2099-01-01T00:00:00.000Z',
            },
            error: null,
          };
        },
      };
      return query;
    });

    await expect(completeMobileMarketplaceUnlock({
      adminSupabase: { rpc, from } as unknown as SupabaseClient,
      userId,
      purchaseIntentId: 'intent-marketplace-1',
      productId: 'magicbooklet.marketplace.usd900',
      provider: 'app_store',
      transactionId: '1000000123456800',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
      alreadyProcessed: true,
    });
  });

  it('uses one atomic database call for mobile post-resource cash unlocks', async () => {
    const invalidateMarketplaceResourceListCache = vi.fn();
    const disallowedTables: string[] = [];
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('complete_mobile_purchase');
      expect(args).toEqual({
        p_user_id: userId,
        p_purchase_intent_id: 'intent-post-1',
        p_product_id: 'magicbooklet.post.usd1200',
        p_provider: 'play_store',
        p_store_transaction_id: 'GPA.1000-2000-3000',
        p_external_order_id: buildMobileExternalOrderId('play_store', 'GPA.1000-2000-3000'),
        p_payment_id: 'mobile_play_store_GPA.1000-2000-3000',
      });
      return {
        data: {
          status: 'completed',
          entitlement_type: 'post_resource_unlock',
          product_id: 'magicbooklet.post.usd1200',
          resource_id: 'post-1',
          amount_subunits: 1200,
          currency: 'USD',
          bundle_id: 'bundle-1',
          owner_user_id: 'owner-1',
        },
        error: null,
      };
    });
    const notificationFrom = createNotificationOnlyFromMock(disallowedTables);
    const from = vi.fn((table: string) => {
      if (table === 'mobile_purchase_intents') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                id: 'intent-post-1',
                user_id: userId,
                product_id: 'magicbooklet.post.usd1200',
                entitlement_type: 'post_resource_unlock',
                resource_id: 'post-1',
                amount_subunits: 1200,
                currency: 'USD',
                credits: null,
                status: 'pending',
                expires_at: '2099-01-01T00:00:00.000Z',
              },
              error: null,
            };
          },
        };
        return query;
      }
      return notificationFrom(table);
    });

    await expect(completeMobilePostResourceUnlock({
      adminSupabase: { rpc, from } as unknown as SupabaseClient,
      userId,
      purchaseIntentId: 'intent-post-1',
      productId: 'magicbooklet.post.usd1200',
      provider: 'play_store',
      transactionId: 'GPA.1000-2000-3000',
      invalidateMarketplaceResourceListCache,
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
      alreadyProcessed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(invalidateMarketplaceResourceListCache).toHaveBeenCalledOnce();
    expect(disallowedTables).toEqual([]);
  });

  it('does not invalidate the marketplace list for an idempotent mobile post-resource replay', async () => {
    const invalidateMarketplaceResourceListCache = vi.fn();
    const rpc = vi.fn(async () => ({
      data: {
        status: 'already_processed',
        entitlement_type: 'post_resource_unlock',
        product_id: 'magicbooklet.post.usd1200',
        resource_id: 'post-1',
        amount_subunits: 1200,
        currency: 'USD',
        bundle_id: 'bundle-1',
        owner_user_id: 'owner-1',
      },
      error: null,
    }));

    await expect(completeMobilePurchase({
      adminSupabase: { rpc } as unknown as SupabaseClient,
      userId,
      authority: {
        entitlementType: 'post_resource_unlock',
        productId: 'magicbooklet.post.usd1200',
        purchaseIntentId: 'intent-post-1',
        resourceId: 'post-1',
        amountSubunits: 1200,
        currency: 'USD',
        credits: null,
      },
      provider: 'play_store',
      transactionId: 'GPA.1000-2000-3000',
      invalidateMarketplaceResourceListCache,
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      alreadyProcessed: true,
    });

    expect(invalidateMarketplaceResourceListCache).not.toHaveBeenCalled();
  });

  it('maps mobile post-resource cash unlock database statuses to user errors', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'not_paid',
      },
      error: null,
    }));
    const from = vi.fn(() => {
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          return {
            data: {
              id: 'intent-post-1',
              user_id: userId,
              product_id: 'magicbooklet.post.usd1200',
              entitlement_type: 'post_resource_unlock',
              resource_id: 'post-1',
              amount_subunits: 1200,
              currency: 'USD',
              credits: null,
              status: 'pending',
              expires_at: '2099-01-01T00:00:00.000Z',
            },
            error: null,
          };
        },
      };
      return query;
    });

    await expect(completeMobilePostResourceUnlock({
      adminSupabase: { rpc, from } as unknown as SupabaseClient,
      userId,
      purchaseIntentId: 'intent-post-1',
      productId: 'magicbooklet.post.usd1200',
      provider: 'play_store',
      transactionId: 'GPA.1000-2000-3000',
    })).rejects.toMatchObject({
      status: 400,
      message: 'This resource does not require a mobile purchase.',
    });
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

  it('excludes sandbox purchases from restore so TestFlight receipts do not mint credits', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.starter': [
            {
              id: 'rc-sandbox',
              store: 'app_store',
              store_transaction_id: '2000000123456700',
              purchase_date: '2026-05-13T12:00:00Z',
              is_sandbox: true,
            },
            {
              id: 'rc-production',
              store: 'app_store',
              store_transaction_id: '1000000123456700',
              purchase_date: '2026-05-12T12:00:00Z',
              is_sandbox: false,
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
      credits: 600,
      restoredCreditPurchases: 1,
      alreadyProcessedCreditPurchases: 0,
    });
    expect(fakeSupabase.transactions).toHaveLength(1);
    expect(fakeSupabase.transactions[0]?.razorpay_order_id).toBe(
      buildMobileExternalOrderId('app_store', '1000000123456700'),
    );
  });

  it('restores sandbox purchases when MOBILE_COMMERCE_ALLOW_SANDBOX=1 is set for staging QA', async () => {
    vi.stubEnv('MOBILE_COMMERCE_ALLOW_SANDBOX', '1');
    const fakeSupabase = createCreditSupabase({ credits: 100 });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.starter': [
            {
              id: 'rc-sandbox',
              store: 'app_store',
              store_transaction_id: '2000000123456700',
              purchase_date: '2026-05-13T12:00:00Z',
              is_sandbox: true,
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
      credits: 600,
      restoredCreditPurchases: 1,
    });
    expect(fakeSupabase.transactions).toHaveLength(1);
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

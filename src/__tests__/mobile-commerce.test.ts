import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  hasAnswered,
  withMobileNotificationHistory,
  type MobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
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
  type MobilePurchaseAuthority,
} from '@/lib/mobile-commerce';
import {
  notifyMarketplaceUnlockCompleted,
  notifyMobileCreditPurchase,
  notifyMobilePurchasesRestored,
  notifyPostResourceUnlockCompleted,
} from '@/lib/mobile-notifications';
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

  it('rejects purchases RevenueCat reports without a store transaction id', async () => {
    // The transaction id keys settlement idempotency. The old synthetic
    // `productId_purchaseDate` fallback could settle the same purchase twice
    // once RevenueCat later reported the real id, so id-less purchases now
    // fail closed instead.
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.creator': [
            {
              store: 'app_store',
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
    })).rejects.toMatchObject({
      status: 400,
      message: 'Mobile purchase receipt did not include a store transaction id.',
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

  it('settles a store-validated sandbox receipt against the reporting store', async () => {
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

  it('settles store-validated sandbox receipts without the staging opt-in', async () => {
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

  // App Review completes every In-App Purchase in the store sandbox against the
  // production backend. Rejecting these is what showed the reviewer an error
  // after StoreKit had already charged them (guideline 2.1(b)).
  it('settles sandbox receipts on a production deployment so App Review can purchase', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
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

  it('still verifies the production purchase when a newer sandbox sibling shares the product', async () => {
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
        p_store_reported_price: null,
        p_store_reported_currency: null,
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
        p_store_reported_price: null,
        p_store_reported_currency: null,
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

  it('restores store-validated sandbox purchases instead of dropping them', async () => {
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
      credits: 1100,
      restoredCreditPurchases: 2,
      alreadyProcessedCreditPurchases: 0,
    });
    expect(fakeSupabase.transactions).toHaveLength(2);
    const orderIds = fakeSupabase.transactions.map((row) => row?.razorpay_order_id);
    expect(orderIds).toContain(buildMobileExternalOrderId('app_store', '1000000123456700'));
    // The sandbox receipt settles under the reporting store, so an id already on
    // file keeps the same external order id and stays idempotent on restore.
    expect(orderIds).toContain(buildMobileExternalOrderId('app_store', '2000000123456700'));
  });

  // Regression: sandbox receipts were settled under `app_store` long before the
  // drop-filter existed, so production holds rows for sandbox transaction ids.
  // Settling such an id under a different provider conflicts on the
  // single-column UNIQUE(store_transaction_id), misses the
  // `(provider, store_transaction_id)` idempotency lookup, and returns
  // `transaction_conflict` -- which reached users as "Mobile purchase does not
  // match the server-issued intent." on every restore.
  it('treats an already-settled sandbox receipt as already processed on restore', async () => {
    const externalOrderId = buildMobileExternalOrderId('app_store', '2000000123456700');
    const fakeSupabase = createCreditSupabase({
      credits: 100,
      transactions: [{
        id: 'txn-existing',
        user_id: userId,
        razorpay_order_id: externalOrderId,
        credits: 500,
        status: 'success',
      }],
    });
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
    }), { headers: { 'content-type': 'application/json' }, status: 200 }));

    await expect(restoreMobileEntitlements(fakeSupabase.client, userId, {
      fetcher: fetcher as unknown as typeof fetch,
      revenueCatApiKey: 'rc-secret',
    })).resolves.toMatchObject({
      success: true,
      restoredCreditPurchases: 0,
      alreadyProcessedCreditPurchases: 1,
    });
    // No second row, and no credits re-granted for a purchase already on file.
    expect(fakeSupabase.transactions).toHaveLength(1);
    expect(fakeSupabase.credits).toBe(100);
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

  it('skips restoring purchases RevenueCat reports without a store transaction id', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      subscriber: {
        non_subscriptions: {
          'magicbooklet.credits.starter': [
            {
              store: 'app_store',
              purchase_date: '2026-05-13T12:00:00Z',
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
      credits: 100,
      restoredCreditPurchases: 0,
    });
    // No settlement may be keyed off a synthesized id.
    expect(fakeSupabase.transactions).toHaveLength(0);
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

const sellerId = '22222222-2222-2222-2222-222222222222';

type SettledPurchaseCase = {
  kind: string;
  authority: MobilePurchaseAuthority;
  /** What `complete_mobile_purchase` reports, minus its status. */
  settlement: Record<string, unknown>;
  /** What the caller is told, minus `alreadyProcessed`. */
  answer: Record<string, unknown>;
  invalidatesMarketplaceList: boolean;
  notifications: Array<Record<string, unknown>>;
};

// One row for each kind of purchase completeMobilePurchase settles.
const settledPurchases: SettledPurchaseCase[] = [
  {
    kind: 'a credit purchase',
    authority: {
      entitlementType: 'credits',
      productId: 'magicbooklet.credits.starter',
      purchaseIntentId: null,
      resourceId: null,
      amountSubunits: 41500,
      currency: 'INR',
      credits: 500,
    },
    settlement: {
      entitlement_type: 'credits',
      product_id: 'magicbooklet.credits.starter',
      resource_id: null,
      amount_subunits: 41500,
      currency: 'INR',
      remaining_credits: 600,
      source_record_id: 'txn-mobile-1',
    },
    answer: { success: true, entitlement: 'credits', credits: 600 },
    invalidatesMarketplaceList: false,
    notifications: [
      {
        user_id: userId,
        type: 'credits_purchased',
        body: 'Your balance is now 600 credits.',
        dedupe_key: 'credits:txn-mobile-1',
      },
    ],
  },
  {
    kind: 'a marketplace unlock',
    authority: {
      entitlementType: 'marketplace_unlock',
      productId: 'magicbooklet.marketplace.usd900',
      purchaseIntentId: 'intent-marketplace-1',
      resourceId: 'asset-1',
      amountSubunits: 900,
      currency: 'USD',
      credits: null,
    },
    settlement: {
      entitlement_type: 'marketplace_unlock',
      product_id: 'magicbooklet.marketplace.usd900',
      resource_id: 'asset-1',
      amount_subunits: 900,
      currency: 'USD',
      seller_user_id: sellerId,
    },
    answer: { success: true, entitlement: 'marketplace_unlock', assetId: 'asset-1' },
    invalidatesMarketplaceList: false,
    notifications: [
      { user_id: userId, type: 'marketplace_unlocked', dedupe_key: `marketplace-unlock:asset-1:${userId}` },
      { user_id: sellerId, type: 'marketplace_unlocked', dedupe_key: `marketplace-sale:asset-1:${userId}` },
    ],
  },
  {
    kind: 'a post resource unlock',
    authority: {
      entitlementType: 'post_resource_unlock',
      productId: 'magicbooklet.post.usd1200',
      purchaseIntentId: 'intent-post-1',
      resourceId: 'post-1',
      amountSubunits: 1200,
      currency: 'USD',
      credits: null,
    },
    settlement: {
      entitlement_type: 'post_resource_unlock',
      product_id: 'magicbooklet.post.usd1200',
      resource_id: 'post-1',
      amount_subunits: 1200,
      currency: 'USD',
      bundle_id: 'bundle-1',
      owner_user_id: sellerId,
    },
    answer: { success: true, entitlement: 'post_resource_unlock', postId: 'post-1' },
    invalidatesMarketplaceList: true,
    notifications: [
      { user_id: userId, type: 'post_resource_unlocked', dedupe_key: `post-resource-unlock:post-1:${userId}` },
      { user_id: sellerId, type: 'post_resource_unlocked', dedupe_key: `post-resource-sale:post-1:${userId}` },
    ],
  },
];

function createSettledPurchaseClient(
  settlement: Record<string, unknown>,
  history: MobileNotificationHistory,
) {
  const rpc = vi.fn(async (name: string) => (
    name === 'settle_referral_purchase_rewards'
      ? { data: { status: 'not_referred', rewards: [] }, error: null }
      : { data: settlement, error: null }
  ));

  return {
    adminSupabase: { rpc, from: (table: string) => history.from(table) } as unknown as SupabaseClient,
    rpc,
  };
}

function revenueCatCreditPurchases(storeTransactionIds: string[]) {
  return vi.fn(async () => new Response(JSON.stringify({
    subscriber: {
      non_subscriptions: {
        'magicbooklet.credits.starter': storeTransactionIds.map((storeTransactionId, index) => ({
          id: `rc-${index + 1}`,
          store: 'app_store',
          store_transaction_id: storeTransactionId,
          purchase_date: '2026-05-13T12:00:00Z',
        })),
      },
    },
  }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  })) as unknown as typeof fetch;
}

describe('mobile purchase notifications', () => {
  // The notifier sends one push request for every device a person has
  // registered, in turn. Measured in production on 2026-10-01 on an unlock: an
  // account with 32 devices held the answer for 15 s. The purchase sync sends
  // the same kind of notification in front of the same kind of answer, with the
  // store's charge already taken and the app giving up on the request at 30 s.
  it.each(settledPurchases)(
    'answers $kind before its notifications go out when the caller can run work after the response',
    async ({ authority, settlement, answer, invalidatesMarketplaceList, notifications }) => {
      const history = createMobileNotificationHistory();
      history.hold();
      const { adminSupabase, rpc } = createSettledPurchaseClient({ status: 'completed', ...settlement }, history);
      const invalidateMarketplaceResourceListCache = vi.fn();
      const deferred: Array<() => Promise<unknown>> = [];

      const purchase = completeMobilePurchase({
        adminSupabase,
        userId,
        authority,
        provider: 'app_store',
        transactionId: '1000000123456789',
        invalidateMarketplaceResourceListCache,
        runAfterResponse: (task) => { deferred.push(task); },
      });

      // A notification that has not finished no longer holds the answer back,
      // and the purchase behind that answer is settled by the same single call.
      expect(await hasAnswered(purchase)).toBe(true);
      await expect(purchase).resolves.toEqual({ ...answer, alreadyProcessed: false });
      expect(rpc.mock.calls.filter(([name]) => name === 'complete_mobile_purchase')).toHaveLength(1);
      expect(invalidateMarketplaceResourceListCache).toHaveBeenCalledTimes(invalidatesMarketplaceList ? 1 : 0);
      expect(history.started).toEqual([]);
      expect(deferred).toHaveLength(1);

      history.release();
      await deferred[0]();
      expect(history.sent).toEqual(notifications.map((notification) => expect.objectContaining(notification)));
    },
  );

  it.each(settledPurchases)(
    'sends the notifications for $kind before answering when the caller has nowhere to run them afterwards',
    async ({ authority, settlement, answer, notifications }) => {
      const history = createMobileNotificationHistory();
      history.hold();
      const { adminSupabase } = createSettledPurchaseClient({ status: 'completed', ...settlement }, history);

      const purchase = completeMobilePurchase({
        adminSupabase,
        userId,
        authority,
        provider: 'app_store',
        transactionId: '1000000123456789',
        invalidateMarketplaceResourceListCache: vi.fn(),
      });

      expect(await hasAnswered(purchase)).toBe(false);
      expect(history.started).toEqual([notifications[0].dedupe_key]);

      history.release();
      await expect(purchase).resolves.toEqual({ ...answer, alreadyProcessed: false });
      expect(history.sent).toEqual(notifications.map((notification) => expect.objectContaining(notification)));
    },
  );

  it.each(settledPurchases)(
    'defers nothing for $kind that was already settled',
    async ({ authority, settlement, answer }) => {
      const history = createMobileNotificationHistory();
      const { adminSupabase } = createSettledPurchaseClient({ status: 'already_processed', ...settlement }, history);
      const runAfterResponse = vi.fn();

      await expect(completeMobilePurchase({
        adminSupabase,
        userId,
        authority,
        provider: 'app_store',
        transactionId: '1000000123456789',
        invalidateMarketplaceResourceListCache: vi.fn(),
        runAfterResponse,
      })).resolves.toEqual({ ...answer, alreadyProcessed: true });

      expect(runAfterResponse).not.toHaveBeenCalled();
      expect(history.started).toEqual([]);
    },
  );

  it('defers nothing when the settlement is refused', async () => {
    const history = createMobileNotificationHistory();
    const { adminSupabase } = createSettledPurchaseClient({ status: 'revoked' }, history);
    const runAfterResponse = vi.fn();

    await expect(completeMobilePurchase({
      adminSupabase,
      userId,
      authority: settledPurchases[0].authority,
      provider: 'app_store',
      transactionId: '1000000123456789',
      runAfterResponse,
    })).rejects.toMatchObject({
      status: 409,
      message: 'This mobile store transaction has been revoked.',
    });

    expect(runAfterResponse).not.toHaveBeenCalled();
    expect(history.started).toEqual([]);
  });

  it('sends the notification in front of the answer rather than fail a settled purchase when the task cannot be queued', async () => {
    const [{ authority, settlement, answer, notifications }] = settledPurchases;
    const history = createMobileNotificationHistory();
    const { adminSupabase } = createSettledPurchaseClient({ status: 'completed', ...settlement }, history);
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      // The store has already charged for this. A scheduler that will not take
      // the task must not turn that into a failed purchase.
      await expect(completeMobilePurchase({
        adminSupabase,
        userId,
        authority,
        provider: 'app_store',
        transactionId: '1000000123456789',
        runAfterResponse: () => {
          throw new Error('`after` was called outside a request scope.');
        },
      })).resolves.toEqual({ ...answer, alreadyProcessed: false });
    } finally {
      restoreLogSink();
    }

    expect(history.sent).toEqual(notifications.map((notification) => expect.objectContaining(notification)));
    expect(logged).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'mobile_commerce_notification_deferral_failed',
        errorMessage: '`after` was called outside a request scope.',
      }),
    ]);
  });

  it('answers a restore before any of its notifications go out, and still sends them one at a time in order', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const restore = restoreMobileEntitlements(
      withMobileNotificationHistory(fakeSupabase.client, history),
      userId,
      {
        fetcher: revenueCatCreditPurchases(['1000000123456701', '1000000123456702']),
        revenueCatApiKey: 'rc-secret',
        runAfterResponse: (task) => { deferred.push(task); },
      },
    );

    expect(await hasAnswered(restore)).toBe(true);
    await expect(restore).resolves.toMatchObject({
      success: true,
      credits: 1100,
      restoredCreditPurchases: 2,
      alreadyProcessedCreditPurchases: 0,
    });
    expect(fakeSupabase.credits).toBe(1100);
    expect(history.started).toEqual([]);

    // Next's after() starts everything it was handed at once. Started that way,
    // the notifications must still go out as they do when nothing is deferred:
    // one behind the other, so a balance of 600 never lands after one of 1,100.
    const sending = Promise.all(deferred.map((task) => task()));
    expect(await hasAnswered(sending)).toBe(false);
    expect(history.started).toEqual(['credits:txn-mobile-1']);

    history.release();
    await sending;
    expect(history.sent.map((notification) => notification.type)).toEqual([
      'credits_purchased',
      'credits_purchased',
      'purchases_restored',
    ]);
    expect(history.sent.slice(0, 2).map((notification) => notification.body)).toEqual([
      'Your balance is now 600 credits.',
      'Your balance is now 1,100 credits.',
    ]);
  });

  it('sends a restore\'s notifications before answering when the caller has nowhere to run them afterwards', async () => {
    const fakeSupabase = createCreditSupabase({ credits: 100 });
    const history = createMobileNotificationHistory();
    history.hold();

    const restore = restoreMobileEntitlements(
      withMobileNotificationHistory(fakeSupabase.client, history),
      userId,
      {
        fetcher: revenueCatCreditPurchases(['1000000123456701', '1000000123456702']),
        revenueCatApiKey: 'rc-secret',
      },
    );

    // Held at the first purchase's notification, with the second purchase not
    // yet settled: each one is settled and then told about, in turn.
    expect(await hasAnswered(restore)).toBe(false);
    expect(history.started).toEqual(['credits:txn-mobile-1']);
    expect(fakeSupabase.transactions).toHaveLength(1);

    history.release();
    await expect(restore).resolves.toMatchObject({
      success: true,
      credits: 1100,
      restoredCreditPurchases: 2,
    });
    expect(history.sent.map((notification) => notification.type)).toEqual([
      'credits_purchased',
      'credits_purchased',
      'purchases_restored',
    ]);
  });

  it('defers only the refresh notice when a restore finds nothing new to settle', async () => {
    const fakeSupabase = createCreditSupabase({
      credits: 600,
      transactions: [{
        id: 'txn-existing',
        user_id: userId,
        razorpay_order_id: buildMobileExternalOrderId('app_store', '1000000123456701'),
        credits: 500,
        status: 'success',
      }],
    });
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const restore = restoreMobileEntitlements(
      withMobileNotificationHistory(fakeSupabase.client, history),
      userId,
      {
        fetcher: revenueCatCreditPurchases(['1000000123456701']),
        revenueCatApiKey: 'rc-secret',
        runAfterResponse: (task) => { deferred.push(task); },
      },
    );

    expect(await hasAnswered(restore)).toBe(true);
    await expect(restore).resolves.toMatchObject({
      success: true,
      credits: 600,
      restoredCreditPurchases: 0,
      alreadyProcessedCreditPurchases: 1,
    });
    expect(history.started).toEqual([]);

    history.release();
    await Promise.all(deferred.map((task) => task()));
    expect(history.sent.map((notification) => notification.type)).toEqual(['purchases_restored']);
  });

  it('still tells the buyer about a purchase the restore settled when a later purchase fails it', async () => {
    // RevenueCat still lists the second purchase, but it was refunded here, so
    // settling it is refused and the restore fails after the first has landed.
    const fakeSupabase = createCreditSupabase({
      credits: 100,
      transactions: [{
        id: 'txn-refunded',
        user_id: userId,
        razorpay_order_id: buildMobileExternalOrderId('app_store', '1000000123456702'),
        credits: 500,
        status: 'refunded',
      }],
    });
    const history = createMobileNotificationHistory();
    history.hold();
    const deferred: Array<() => Promise<unknown>> = [];

    const restore = restoreMobileEntitlements(
      withMobileNotificationHistory(fakeSupabase.client, history),
      userId,
      {
        fetcher: revenueCatCreditPurchases(['1000000123456701', '1000000123456702']),
        revenueCatApiKey: 'rc-secret',
        runAfterResponse: (task) => { deferred.push(task); },
      },
    );

    expect(await hasAnswered(restore)).toBe(true);
    await expect(restore).rejects.toMatchObject({
      status: 409,
      message: 'This mobile store transaction has been revoked.',
    });
    expect(fakeSupabase.credits).toBe(600);

    history.release();
    await Promise.all(deferred.map((task) => task()));
    expect(history.sent.map((notification) => notification.type)).toEqual(['credits_purchased']);
  });

  // Sending a notifier after the response moves it out from under the request:
  // an error it threw would no longer fail the purchase, it would only reach
  // the log. That hides nothing as long as none of them can reject, which is
  // what this pins for each notifier the purchase paths queue.
  it.each<[string, (client: SupabaseClient) => Promise<unknown>]>([
    ['a credit purchase', (client) => notifyMobileCreditPurchase(client, {
      userId,
      credits: 600,
      transactionId: 'txn-mobile-1',
    })],
    ['a marketplace unlock', (client) => notifyMarketplaceUnlockCompleted(client, {
      buyerUserId: userId,
      sellerUserId: sellerId,
      assetId: 'asset-1',
    })],
    ['a post resource unlock', (client) => notifyPostResourceUnlockCompleted(client, {
      buyerUserId: userId,
      ownerUserId: sellerId,
      postId: 'post-1',
      bundleId: 'bundle-1',
    })],
    ['a restore', (client) => notifyMobilePurchasesRestored(client, userId)],
  ])('the notifier for %s logs a failure instead of rejecting', async (_purchase, notify) => {
    const unavailable = {
      from: () => {
        throw new Error('database unavailable');
      },
    } as unknown as SupabaseClient;
    const logged: BackendLogRecord[] = [];
    const restoreLogSink = setBackendLogSink((record) => { logged.push(record); });

    try {
      await expect(notify(unavailable)).resolves.toBeNull();
    } finally {
      restoreLogSink();
    }

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.map((record) => record.msg)).toEqual(
      logged.map(() => 'failed_to_create_mobile_notification'),
    );
  });
});

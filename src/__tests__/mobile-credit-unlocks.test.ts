import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  MobileCommerceError,
  unlockMarketplaceAssetWithCredits,
  unlockPostResourceBundleWithCredits,
} from '@/lib/mobile-commerce';

const userId = '11111111-1111-1111-1111-111111111111';
const ownerId = '22222222-2222-2222-2222-222222222222';

function createBundleCreditSupabase(options: {
  credits?: number;
  bundle?: {
    id: string;
    post_id: string;
    owner_user_id: string;
    access_mode: 'free' | 'paid';
    status: 'draft' | 'published';
    price_usd_cents: number;
  } | null;
  purchases?: Array<{ bundle_id: string; buyer_user_id: string }>;
} = {}) {
  let credits = options.credits ?? 1000;
  const bundlePurchases = [...(options.purchases ?? [])];
  const bundleOrders: Array<{
    id: string;
    bundle_id: string;
    buyer_user_id: string;
    razorpay_order_id: string;
    amount_subunits: number;
    currency: string;
    status: 'created' | 'paid';
  }> = [];

  const bundle = options.bundle ?? {
    id: 'bundle-1',
    post_id: 'post-1',
    owner_user_id: ownerId,
    access_mode: 'paid' as const,
    status: 'published' as const,
    price_usd_cents: 900,
  };

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

        if (table === 'post_resource_bundles') {
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
              const matches = bundle
                && Object.entries(filters).every(([key, value]) => (bundle as Record<string, unknown>)[key] === value);
              return { data: matches ? bundle : null, error: null };
            },
          };
          return query;
        }

        if (table === 'post_resource_bundle_purchases') {
          const filters: Record<string, unknown> = {};
          return {
            select() {
              return {
                eq(column: string, value: unknown) {
                  filters[column] = value;
                  return this;
                },
                async maybeSingle() {
                  const purchase = bundlePurchases.find((candidate) =>
                    Object.entries(filters).every(([key, value]) => (candidate as Record<string, unknown>)[key] === value)
                  ) ?? null;
                  return { data: purchase, error: null };
                },
              };
            },
          };
        }

        if (table === 'post_resource_bundle_orders') {
          return {
            insert(values: Record<string, unknown>) {
              const row = {
                id: 'order-1',
                bundle_id: String(values.bundle_id),
                buyer_user_id: String(values.buyer_user_id),
                razorpay_order_id: String(values.razorpay_order_id),
                amount_subunits: Number(values.amount_subunits),
                currency: String(values.currency),
                status: 'created' as const,
              };
              bundleOrders.push(row);
              return {
                select() {
                  return {
                    async single() {
                      return { data: row, error: null };
                    },
                  };
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === 'deduct_credits') {
          const cost = Number(args.p_cost ?? 0);
          if (credits < cost) {
            return { data: -1, error: null };
          }
          credits -= cost;
          return { data: credits, error: null };
        }

        if (name === 'refund_credits') {
          credits += Number(args.p_amount ?? 0);
          return { data: true, error: null };
        }

        if (name === 'complete_post_resource_bundle_purchase') {
          const order = bundleOrders.find((candidate) => candidate.razorpay_order_id === args.p_razorpay_order_id);
          if (!order || !bundle) {
            return { data: false, error: null };
          }
          order.status = 'paid';
          const existing = bundlePurchases.find((purchase) => purchase.bundle_id === order.bundle_id && purchase.buyer_user_id === order.buyer_user_id);
          if (!existing) {
            bundlePurchases.push({
              bundle_id: order.bundle_id,
              buyer_user_id: order.buyer_user_id,
            });
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }

        throw new Error(`Unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient,
    get credits() {
      return credits;
    },
    bundlePurchases,
  };
}

function createMarketplaceCreditSupabase(options: {
  credits?: number;
  asset?: {
    id: string;
    seller_user_id: string;
    status: 'draft' | 'active' | 'unlisted' | 'deleted';
    price_usd_cents: number;
  } | null;
  purchases?: Array<{ asset_id: string; buyer_user_id: string }>;
} = {}) {
  let credits = options.credits ?? 1000;
  const marketplacePurchases = [...(options.purchases ?? [])];
  const marketplaceOrders: Array<{
    id: string;
    asset_id: string;
    buyer_user_id: string;
    razorpay_order_id: string;
    amount_subunits: number;
    currency: string;
    status: 'created' | 'paid';
  }> = [];

  const asset = options.asset ?? {
    id: 'asset-1',
    seller_user_id: ownerId,
    status: 'active' as const,
    price_usd_cents: 700,
  };

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

        if (table === 'marketplace_assets') {
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
              const matches = asset
                && Object.entries(filters).every(([key, value]) => (asset as Record<string, unknown>)[key] === value);
              return { data: matches ? asset : null, error: null };
            },
          };
          return query;
        }

        if (table === 'marketplace_purchases') {
          const filters: Record<string, unknown> = {};
          return {
            select() {
              return {
                eq(column: string, value: unknown) {
                  filters[column] = value;
                  return this;
                },
                async maybeSingle() {
                  const purchase = marketplacePurchases.find((candidate) =>
                    Object.entries(filters).every(([key, value]) => (candidate as Record<string, unknown>)[key] === value)
                  ) ?? null;
                  return { data: purchase, error: null };
                },
              };
            },
          };
        }

        if (table === 'marketplace_orders') {
          return {
            insert(values: Record<string, unknown>) {
              marketplaceOrders.push({
                id: 'marketplace-order-1',
                asset_id: String(values.asset_id),
                buyer_user_id: String(values.buyer_user_id),
                razorpay_order_id: String(values.razorpay_order_id),
                amount_subunits: Number(values.amount_subunits),
                currency: String(values.currency),
                status: 'created',
              });
              return { error: null };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === 'deduct_credits') {
          const cost = Number(args.p_cost ?? 0);
          if (credits < cost) {
            return { data: -1, error: null };
          }
          credits -= cost;
          return { data: credits, error: null };
        }

        if (name === 'refund_credits') {
          credits += Number(args.p_amount ?? 0);
          return { data: true, error: null };
        }

        if (name === 'complete_marketplace_purchase') {
          const order = marketplaceOrders.find((candidate) => candidate.razorpay_order_id === args.p_razorpay_order_id);
          if (!order || !asset) {
            return { data: false, error: null };
          }
          order.status = 'paid';
          const existing = marketplacePurchases.find((purchase) => purchase.asset_id === order.asset_id && purchase.buyer_user_id === order.buyer_user_id);
          if (!existing) {
            marketplacePurchases.push({
              asset_id: order.asset_id,
              buyer_user_id: order.buyer_user_id,
            });
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }

        throw new Error(`Unexpected RPC: ${name}`);
      },
    } as unknown as SupabaseClient,
    get credits() {
      return credits;
    },
    marketplacePurchases,
  };
}

describe('credit-funded mobile unlocks', () => {
  it('unlocks a paid marketplace asset by spending credits', async () => {
    const fakeSupabase = createMarketplaceCreditSupabase({ credits: 1000 });

    await expect(unlockMarketplaceAssetWithCredits({
      adminSupabase: fakeSupabase.client,
      userId,
      assetId: 'asset-1',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'marketplace_unlock',
      assetId: 'asset-1',
      credits: 300,
      alreadyProcessed: false,
    });
    expect(fakeSupabase.marketplacePurchases).toEqual([{ asset_id: 'asset-1', buyer_user_id: userId }]);
  });

  it('unlocks a paid post resource bundle by spending credits', async () => {
    const fakeSupabase = createBundleCreditSupabase({ credits: 1000 });

    await expect(unlockPostResourceBundleWithCredits({
      adminSupabase: fakeSupabase.client,
      userId,
      postId: 'post-1',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
      credits: 100,
      alreadyProcessed: false,
    });
    expect(fakeSupabase.bundlePurchases).toEqual([{ bundle_id: 'bundle-1', buyer_user_id: userId }]);
  });

  it('returns already processed when the user already owns the bundle', async () => {
    const fakeSupabase = createBundleCreditSupabase({
      credits: 100,
      purchases: [{ bundle_id: 'bundle-1', buyer_user_id: userId }],
    });

    await expect(unlockPostResourceBundleWithCredits({
      adminSupabase: fakeSupabase.client,
      userId,
      postId: 'post-1',
    })).resolves.toMatchObject({
      success: true,
      entitlement: 'post_resource_unlock',
      postId: 'post-1',
      credits: 100,
      alreadyProcessed: true,
    });
  });

  it('rejects unlocks when the user does not have enough credits', async () => {
    const fakeSupabase = createBundleCreditSupabase({ credits: 50 });

    await expect(unlockPostResourceBundleWithCredits({
      adminSupabase: fakeSupabase.client,
      userId,
      postId: 'post-1',
    })).rejects.toMatchObject({
      status: 402,
    } satisfies Partial<MobileCommerceError>);
  });

  it('rejects marketplace asset unlocks when the user does not have enough credits', async () => {
    const fakeSupabase = createMarketplaceCreditSupabase({ credits: 50 });

    await expect(unlockMarketplaceAssetWithCredits({
      adminSupabase: fakeSupabase.client,
      userId,
      assetId: 'asset-1',
    })).rejects.toMatchObject({
      status: 402,
    } satisfies Partial<MobileCommerceError>);
  });
});

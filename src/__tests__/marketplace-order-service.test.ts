import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMarketplaceOrderForRoute as createMarketplaceOrderForRouteImpl,
} from '@/lib/marketplace-order-service';

type CreateMarketplaceOrderInput = Parameters<typeof createMarketplaceOrderForRouteImpl>[0];

function createMarketplaceOrderForRoute(
  input: Omit<CreateMarketplaceOrderInput, 'clientIntentKey' | 'fetchRazorpayOrderByReceipt'>
    & Partial<Pick<CreateMarketplaceOrderInput, 'clientIntentKey' | 'fetchRazorpayOrderByReceipt'>>,
) {
  return createMarketplaceOrderForRouteImpl({
    clientIntentKey: 'intent-marketplace-123456',
    fetchRazorpayOrderByReceipt: vi.fn(async () => null),
    ...input,
  });
}

type MarketplaceAssetRow = {
  id: string;
  title: string;
  price_usd_cents: number;
  status: 'draft' | 'active' | 'unlisted' | 'deleted';
  seller_user_id: string;
};

type MarketplacePurchaseRow = {
  asset_id: string;
  buyer_user_id: string;
};

function createAdminSupabaseMock(options?: {
  assets?: MarketplaceAssetRow[];
  purchases?: MarketplacePurchaseRow[];
  rateLimited?: boolean;
}) {
  const assets = options?.assets ?? [{
    id: 'asset-1',
    title: 'Prompt Pack',
    price_usd_cents: 500,
    status: 'active' as const,
    seller_user_id: 'seller-1',
  }];
  const purchases = options?.purchases ?? [];
  const tableReads: string[] = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function createQuery<T extends Record<string, unknown>>(table: string, rows: T[]) {
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
        tableReads.push(table);
        return {
          data: rows.find((row) =>
            Object.entries(filters).every(([key, value]) => row[key] === value)
          ) ?? null,
          error: null,
        };
      },
    };

    return query;
  }

  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });

      if (fn === 'check_backend_rate_limit') {
        return {
          data: {
            allowed: !options?.rateLimited,
            limit: 10,
            remaining: options?.rateLimited ? 0 : 9,
            retryAfterSeconds: options?.rateLimited ? 41 : 0,
            resetAt: '2026-06-22T10:00:00.000Z',
          },
          error: null,
        };
      }

      if (fn === 'claim_razorpay_checkout_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '20000000-0000-4000-8000-000000000002',
            provider_receipt: 'mb_20000000000040008000000000000002',
            provider_order_id: null,
          },
          error: null,
        };
      }
      if (fn === 'complete_razorpay_checkout_intent') {
        return {
          data: {
            status: 'recorded',
            provider_order_id: args.p_provider_order_id,
          },
          error: null,
        };
      }

      return { data: true, error: null };
    },
    from(table: string) {
      if (table === 'marketplace_assets') return createQuery(table, assets);
      if (table === 'marketplace_purchases') return createQuery(table, purchases);
      if (table === 'marketplace_orders') {
        return {
          async insert(payload: Record<string, unknown>) {
            inserts.push({ table, payload });
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    inserts,
    rpcCalls,
    tableReads,
  };
}

describe('createMarketplaceOrderForRoute', () => {
  it('rate limits before listing lookup, pricing, or provider work', async () => {
    const admin = createAdminSupabaseMock({ rateLimited: true });
    const getMarketplacePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createMarketplaceOrderForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      buyerUserId: 'buyer-1',
      countryCode: 'IN',
      createRazorpayOrder,
      getMarketplacePriceQuote,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 41,
      },
    });
    expect(admin.rpcCalls).toEqual([
      {
        fn: 'check_backend_rate_limit',
        args: {
          p_scope: 'marketplace-order:create',
          p_subject_key: 'buyer-1',
          p_limit: 10,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(admin.tableReads).toEqual([]);
    expect(getMarketplacePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it('quotes, creates, and records paid marketplace orders', async () => {
    const admin = createAdminSupabaseMock();
    const getMarketplacePriceQuote = vi.fn(async () => ({
      amountSubunits: 41500,
      currency: 'INR' as const,
      formatted: '₹415',
      note: 'Charged in INR for buyers in India.',
    }));
    const createRazorpayOrder = vi.fn(async () => ({
      id: 'order_market_123',
    }));

    const result = await createMarketplaceOrderForRoute({
      adminSupabase: admin.client,
      assetId: 'asset-1',
      buyerUserId: 'buyer-1',
      countryCode: 'IN',
      createRazorpayOrder,
      getMarketplacePriceQuote,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        assetId: 'asset-1',
        orderId: 'order_market_123',
        amount: 41500,
        currency: 'INR',
        displayPrice: '₹415',
        note: 'Charged in INR for buyers in India.',
        listingTitle: 'Prompt Pack',
      },
    });
    expect(admin.tableReads).toEqual(['marketplace_assets', 'marketplace_purchases']);
    expect(getMarketplacePriceQuote).toHaveBeenCalledWith(500, 'IN');
    expect(createRazorpayOrder).toHaveBeenCalledWith({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      amount: 41500,
      currency: 'INR',
      receipt: 'mb_20000000000040008000000000000002',
      notes: {
        asset_id: 'asset-1',
        buyer_user_id: 'buyer-1',
        purchase_kind: 'marketplace',
      },
    });
    expect(admin.inserts).toEqual([
      {
        table: 'marketplace_orders',
        payload: {
          asset_id: 'asset-1',
          buyer_user_id: 'buyer-1',
          razorpay_order_id: 'order_market_123',
          amount_subunits: 41500,
          currency: 'INR',
          status: 'created',
        },
      },
    ]);
  });
});

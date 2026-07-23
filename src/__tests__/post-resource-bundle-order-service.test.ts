import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createPostResourceBundleOrderForRoute } from '@/lib/post-resource-bundle-order-service';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';

type BundleForOrder = {
  id: string;
  post_id: string;
  owner_user_id: string;
  access_mode: 'paid' | 'free';
  status: 'published' | 'draft';
  title: string;
  price_usd_cents: number;
};

type BundlePurchaseRow = {
  bundle_id: string;
  buyer_user_id: string;
};

function createAdminSupabaseMock(options?: {
  purchases?: BundlePurchaseRow[];
  rateLimited?: boolean;
}) {
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
            retryAfterSeconds: options?.rateLimited ? 39 : 0,
            resetAt: '2026-06-22T10:00:00.000Z',
          },
          error: null,
        };
      }

      return { data: true, error: null };
    },
    from(table: string) {
      if (table === 'post_resource_bundle_purchases') return createQuery(table, purchases);
      if (table === 'post_resource_bundle_orders') {
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

function createBundle(overrides?: Partial<BundleForOrder>): BundleForOrder {
  return {
    id: 'bundle-1',
    post_id: 'post-1',
    owner_user_id: 'owner-1',
    access_mode: 'paid',
    status: 'published',
    title: 'Launch Hook Pack',
    price_usd_cents: 700,
    ...overrides,
  };
}

describe('createPostResourceBundleOrderForRoute', () => {
  it('rate limits before body parsing, bundle lookup, pricing, or provider work', async () => {
    const admin = createAdminSupabaseMock({ rateLimited: true });
    const readBody = vi.fn(async () => ({ locale: 'en-IN' }));
    const getBundleForOrderByPostId = vi.fn();
    const getPostResourceBundlePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'IN',
      readBody,
      getBundleForOrderByPostId,
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 39,
      },
    });
    expect(admin.rpcCalls).toEqual([
      {
        fn: 'check_backend_rate_limit',
        args: {
          p_scope: 'post-resource-order:create',
          p_subject_key: 'buyer-1',
          p_limit: 10,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(readBody).not.toHaveBeenCalled();
    expect(admin.tableReads).toEqual([]);
    expect(getBundleForOrderByPostId).not.toHaveBeenCalled();
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it('returns existing purchases without pricing or provider work', async () => {
    const admin = createAdminSupabaseMock({
      purchases: [{ bundle_id: 'bundle-1', buyer_user_id: 'buyer-1' }],
    });
    const getPostResourceBundlePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: null,
      readBody: vi.fn(async () => ({ locale: 'en-US' })),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, alreadyPurchased: true },
    });
    expect(admin.tableReads).toEqual(['post_resource_bundle_purchases']);
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it('quotes, creates, and records paid resource bundle orders', async () => {
    const admin = createAdminSupabaseMock();
    const getPostResourceBundlePriceQuote = vi.fn(async () => ({
      amountSubunits: 58100,
      currency: 'INR' as const,
      formatted: 'INR 581',
      note: 'Charged in INR for buyers in India.',
    }));
    const createRazorpayOrder = vi.fn(async () => ({ id: 'order_bundle_123' }));

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: null,
      readBody: vi.fn(async () => ({ locale: 'en-IN' })),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
      now: () => 1_787_355_200_000,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        postId: 'post-1',
        bundleId: 'bundle-1',
        orderId: 'order_bundle_123',
        amount: 58100,
        currency: 'INR',
        displayPrice: 'INR 581',
        note: 'Charged in INR for buyers in India.',
        bundleTitle: 'Launch Hook Pack',
      },
    });
    expect(getPostResourceBundlePriceQuote).toHaveBeenCalledWith(700, 'IN');
    expect(createRazorpayOrder).toHaveBeenCalledWith({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      amount: 58100,
      currency: 'INR',
      receipt: 'bundle_buyer-1_1787355200000',
      notes: {
        bundle_id: 'bundle-1',
        buyer_user_id: 'buyer-1',
        post_id: 'post-1',
      },
    });
    expect(admin.inserts).toEqual([
      {
        table: 'post_resource_bundle_orders',
        payload: {
          bundle_id: 'bundle-1',
          buyer_user_id: 'buyer-1',
          razorpay_order_id: 'order_bundle_123',
          amount_subunits: 58100,
          currency: 'INR',
          status: 'created',
        },
      },
    ]);
  });

  it('keeps sub-dollar packages credit-only before quoting or provider work', async () => {
    const admin = createAdminSupabaseMock();
    const getPostResourceBundlePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'IN',
      readBody: vi.fn(async () => ({ locale: 'en-IN' })),
      getBundleForOrderByPostId: vi.fn(async () => createBundle({ price_usd_cents: 90 })),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: {
        error: 'Recipes below 100 tokens can only be unlocked with credits.',
        code: 'CREDITS_ONLY_PRICE',
        creditCost: 90,
        cashMinimumTokens: 100,
      },
    });
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
    expect(admin.inserts).toEqual([]);
  });

  it('maps payment provider timeouts without recording an order', async () => {
    const admin = createAdminSupabaseMock();
    const createRazorpayOrder = vi.fn(async () => {
      throw new ExternalServiceTimeoutError('Razorpay', 5000);
    });

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'IN',
      readBody: vi.fn(async () => ({ locale: 'en-IN' })),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote: vi.fn(async () => ({
        amountSubunits: 58100,
        currency: 'INR' as const,
        formatted: 'INR 581',
        note: null,
      })),
      createRazorpayOrder,
    });

    expect(result).toEqual({
      ok: false,
      status: 504,
      body: { error: 'Payment provider timed out. Please try again.' },
    });
    expect(admin.inserts).toEqual([]);
  });
});

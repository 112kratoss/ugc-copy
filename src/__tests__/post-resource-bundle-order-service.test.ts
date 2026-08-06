import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createPostResourceBundleOrderForRoute as createPostResourceBundleOrderForRouteImpl,
} from '@/lib/post-resource-bundle-order-service';
import { ExternalServiceTimeoutError } from '@/lib/provider-fetch';

type CreateBundleOrderInput = Parameters<typeof createPostResourceBundleOrderForRouteImpl>[0];

function createPostResourceBundleOrderForRoute(
  input: Omit<CreateBundleOrderInput, 'fetchRazorpayOrderByReceipt'>,
) {
  const originalReadBody = input.readBody;
  return createPostResourceBundleOrderForRouteImpl({
    ...input,
    readBody: async () => ({
      clientIntentKey: 'intent-post-resource-123456',
      ...(await originalReadBody()),
    }),
    fetchRazorpayOrderByReceipt: vi.fn(async () => null),
  });
}

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

type CashQuote = {
  status: string;
  bundle_id?: string;
  post_id?: string;
  owner_user_id?: string;
  title?: string;
  price_usd_cents?: number;
  revision_id?: string;
  content_fingerprint?: string;
};

function createCashQuote(overrides?: Partial<CashQuote>): CashQuote {
  return {
    status: 'quoted',
    bundle_id: 'bundle-1',
    post_id: 'post-1',
    owner_user_id: 'owner-1',
    title: 'Launch Hook Pack',
    price_usd_cents: 700,
    revision_id: 'revision-1',
    content_fingerprint: 'fingerprint-1',
    ...overrides,
  };
}

function createAdminSupabaseMock(options?: {
  purchases?: BundlePurchaseRow[];
  rateLimited?: boolean;
  cashQuote?: CashQuote;
  cashQuoteError?: { message: string } | null;
  orderRecord?: { status: string; order_id?: string };
  orderRecordError?: { message: string } | null;
}) {
  const purchases = options?.purchases ?? [];
  const tableReads: string[] = [];
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
      if (fn === 'get_post_resource_bundle_cash_quote') {
        return {
          data: options?.cashQuote ?? createCashQuote(),
          error: options?.cashQuoteError ?? null,
        };
      }
      if (fn === 'claim_razorpay_checkout_intent') {
        return {
          data: {
            status: 'claimed',
            intent_id: '30000000-0000-4000-8000-000000000003',
            provider_receipt: 'mb_30000000000040008000000000000003',
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
      if (fn === 'abandon_razorpay_checkout_intent') {
        return { data: { status: 'abandoned' }, error: null };
      }
      if (fn === 'record_post_resource_bundle_cash_order') {
        return {
          data: options?.orderRecord ?? { status: 'created', order_id: 'local-order-1' },
          error: options?.orderRecordError ?? null,
        };
      }

      throw new Error(`Unexpected RPC: ${fn}`);
    },
    from(table: string) {
      if (table === 'post_resource_bundle_purchases') return createQuery(table, purchases);
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
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
      body: { code: 'RATE_LIMITED', retryAfterSeconds: 39 },
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
  });

  it('returns existing purchases without creating a database or provider quote', async () => {
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
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('get_post_resource_bundle_cash_quote');
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it('prices and records the exact authoritative revision returned under the bundle lock', async () => {
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
      receipt: 'mb_30000000000040008000000000000003',
      notes: {
        bundle_id: 'bundle-1',
        buyer_user_id: 'buyer-1',
        post_id: 'post-1',
        purchase_kind: 'post_resource',
        revision_id: 'revision-1',
      },
    });
    expect(admin.rpcCalls).toContainEqual({
      fn: 'record_post_resource_bundle_cash_order',
      args: {
        p_post_id: 'post-1',
        p_bundle_id: 'bundle-1',
        p_buyer_user_id: 'buyer-1',
        p_razorpay_order_id: 'order_bundle_123',
        p_amount_subunits: 58100,
        p_currency: 'INR',
        p_expected_price_usd_cents: 700,
        p_expected_revision_id: 'revision-1',
        p_expected_content_fingerprint: 'fingerprint-1',
      },
    });
    expect(admin.rpcCalls).toContainEqual(expect.objectContaining({
      fn: 'claim_razorpay_checkout_intent',
      args: expect.objectContaining({ p_request_hash: expect.any(String) }),
    }));
  });

  it('uses the authoritative database price if the preliminary bundle read was stale', async () => {
    const admin = createAdminSupabaseMock({ cashQuote: createCashQuote({ price_usd_cents: 900 }) });
    const getPostResourceBundlePriceQuote = vi.fn(async () => ({
      amountSubunits: 900,
      currency: 'USD' as const,
      formatted: '$9.00',
      note: null,
    }));

    await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle({ price_usd_cents: 700 })),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_bundle_900' })),
    });

    expect(getPostResourceBundlePriceQuote).toHaveBeenCalledWith(900, 'US');
    expect(admin.rpcCalls).toContainEqual(expect.objectContaining({
      fn: 'record_post_resource_bundle_cash_order',
      args: expect.objectContaining({ p_expected_price_usd_cents: 900 }),
    }));
  });

  it('rejects a listing edit that wins the race between provider creation and local recording', async () => {
    const admin = createAdminSupabaseMock({ orderRecord: { status: 'quote_changed' } });

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote: vi.fn(async () => ({
        amountSubunits: 700,
        currency: 'USD' as const,
        formatted: '$7.00',
        note: null,
      })),
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_raced' })),
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'This unlock changed while checkout was opening. Review the latest version and try again.',
        code: 'RESOURCE_QUOTE_CHANGED',
      },
    });
    expect(admin.rpcCalls).toContainEqual(expect.objectContaining({
      fn: 'record_post_resource_bundle_cash_order',
      args: expect.objectContaining({
        p_razorpay_order_id: 'order_raced',
        p_expected_revision_id: 'revision-1',
        p_expected_content_fingerprint: 'fingerprint-1',
      }),
    }));
  });

  it('accepts an idempotent local-order replay only through the locked recorder', async () => {
    const admin = createAdminSupabaseMock({
      orderRecord: { status: 'replay', order_id: 'local-order-existing' },
    });

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote: vi.fn(async () => ({
        amountSubunits: 700,
        currency: 'USD' as const,
        formatted: '$7.00',
        note: null,
      })),
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_replayed' })),
    });

    expect(result).toMatchObject({
      ok: true,
      body: { orderId: 'order_replayed', bundleId: 'bundle-1' },
    });
    expect(admin.rpcCalls.filter((call) => call.fn === 'record_post_resource_bundle_cash_order')).toHaveLength(1);
  });

  it('binds checkout-intent replay identity to the exact same-price revision', async () => {
    const first = createAdminSupabaseMock({
      cashQuote: createCashQuote({
        revision_id: 'revision-1',
        content_fingerprint: 'fingerprint-1',
      }),
    });
    const second = createAdminSupabaseMock({
      cashQuote: createCashQuote({
        revision_id: 'revision-2',
        content_fingerprint: 'fingerprint-2',
      }),
    });
    const routeInput = {
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote: vi.fn(async () => ({
        amountSubunits: 700,
        currency: 'USD' as const,
        formatted: '$7.00',
        note: null,
      })),
    };

    await createPostResourceBundleOrderForRoute({
      ...routeInput,
      adminSupabase: first.client,
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_revision_1' })),
    });
    await createPostResourceBundleOrderForRoute({
      ...routeInput,
      adminSupabase: second.client,
      createRazorpayOrder: vi.fn(async () => ({ id: 'order_revision_2' })),
    });

    const firstClaim = first.rpcCalls.find((call) => call.fn === 'claim_razorpay_checkout_intent');
    const secondClaim = second.rpcCalls.find((call) => call.fn === 'claim_razorpay_checkout_intent');
    expect(firstClaim?.args.p_request_hash).toEqual(expect.any(String));
    expect(secondClaim?.args.p_request_hash).toEqual(expect.any(String));
    expect(firstClaim?.args.p_request_hash).not.toBe(secondClaim?.args.p_request_hash);
  });

  it('routes a paid-to-free race to the free unlock endpoint', async () => {
    const admin = createAdminSupabaseMock({ cashQuote: { status: 'free' } });
    const getPostResourceBundlePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Use the free recipe access endpoint for this bundle.' },
    });
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it('fails closed when the locked quote cannot be obtained', async () => {
    const admin = createAdminSupabaseMock({ cashQuoteError: { message: 'quote failed' } });
    const getPostResourceBundlePriceQuote = vi.fn();
    const createRazorpayOrder = vi.fn();

    const result = await createPostResourceBundleOrderForRoute({
      adminSupabase: admin.client,
      postId: 'post-1',
      buyerUserId: 'buyer-1',
      countryHeader: 'US',
      readBody: vi.fn(async () => ({})),
      getBundleForOrderByPostId: vi.fn(async () => createBundle()),
      getPostResourceBundlePriceQuote,
      createRazorpayOrder,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare a secure checkout quote.' },
    });
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
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
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('get_post_resource_bundle_cash_quote');
    expect(getPostResourceBundlePriceQuote).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
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
    expect(admin.rpcCalls.map((call) => call.fn)).not.toContain('record_post_resource_bundle_cash_order');
  });
});

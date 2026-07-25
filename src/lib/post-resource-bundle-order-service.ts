import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_ORDER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { MarketplacePriceQuote } from '@/lib/marketplace';
import {
  getBundleForOrderByPostId as defaultGetBundleForOrderByPostId,
  getPostResourceBundlePriceQuote as defaultGetPostResourceBundlePriceQuote,
} from '@/lib/post-resource-bundles-server';
import {
  createRazorpayOrder as defaultCreateRazorpayOrder,
  RazorpayOrderError,
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  POST_RESOURCE_WEB_CASH_MIN_TOKENS,
  isPostResourceWebCashEligible,
} from '@/lib/post-resource-commerce';

type BundleForOrder = {
  id: string;
  post_id: string;
  owner_user_id: string;
  access_mode: string;
  status: string;
  title: string;
  price_usd_cents: number;
};

type ReadOrderBody = () => Promise<{
  locale?: string | null;
}>;

type GetBundleForOrderByPostId = (postId: string) => Promise<BundleForOrder | null>;

type CreateRazorpayOrder = (input: {
  keyId?: string | null;
  keySecret?: string | null;
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}) => Promise<RazorpayOrderResponse>;

export type PostResourceBundleOrderRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500 | 502 | 504;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreatePostResourceBundleOrderParams = {
  adminSupabase: SupabaseClient;
  postId: string;
  buyerUserId: string;
  countryHeader: string | null;
  readBody: ReadOrderBody;
  createRazorpayOrder?: CreateRazorpayOrder;
  getBundleForOrderByPostId?: GetBundleForOrderByPostId;
  getPostResourceBundlePriceQuote?: (
    priceUsdCents: number,
    countryCode?: string | null,
  ) => Promise<MarketplacePriceQuote>;
  now?: () => number;
};

export function inferPostResourceBundleOrderCountryFromLocale(locale: string | null): string | null {
  if (!locale) {
    return null;
  }

  try {
    const parsed = new Intl.Locale(locale);
    return parsed.region?.toUpperCase() ?? null;
  } catch {
    const match = locale.match(/-([A-Za-z]{2})\b/);
    return match ? match[1].toUpperCase() : null;
  }
}

function buildReceipt(userId: string, now: () => number) {
  return `bundle_${userId.slice(0, 8)}_${now()}`;
}

function createRateLimitResult(error: BackendRateLimitError): PostResourceBundleOrderRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

export async function createPostResourceBundleOrderForRoute({
  adminSupabase,
  postId,
  buyerUserId,
  countryHeader,
  readBody,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  getBundleForOrderByPostId = defaultGetBundleForOrderByPostId as GetBundleForOrderByPostId,
  getPostResourceBundlePriceQuote = defaultGetPostResourceBundlePriceQuote,
  now = Date.now,
}: CreatePostResourceBundleOrderParams): Promise<PostResourceBundleOrderRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_ORDER_RATE_LIMIT,
      key: buyerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('post_resource_order_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check resource order limits.' },
    };
  }

  const body = await readBody();
  const bundle = await getBundleForOrderByPostId(postId);
  if (!bundle || bundle.status !== 'published') {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }

  if (bundle.owner_user_id === buyerUserId) {
    return { ok: false, status: 400, body: { error: 'You already own this unlock.' } };
  }

  const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
    .from('post_resource_bundle_purchases')
    .select('bundle_id')
    .eq('bundle_id', bundle.id)
    .eq('buyer_user_id', buyerUserId)
    .maybeSingle();

  if (existingPurchaseError) {
    logBackendError('failed_to_check_post_resource_bundle_purchase', { error: existingPurchaseError });
    return { ok: false, status: 500, body: { error: 'Failed to check purchase history.' } };
  }

  if (existingPurchase) {
    return {
      ok: true,
      body: { success: true, alreadyPurchased: true },
    };
  }

  if (bundle.access_mode === 'free' || bundle.price_usd_cents === 0) {
    return { ok: false, status: 400, body: { error: 'Use the free recipe access endpoint for this bundle.' } };
  }

  if (!isPostResourceWebCashEligible(bundle.price_usd_cents)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Recipes below ${POST_RESOURCE_WEB_CASH_MIN_TOKENS} tokens can only be unlocked with credits.`,
        code: 'CREDITS_ONLY_PRICE',
        creditCost: bundle.price_usd_cents,
        cashMinimumTokens: POST_RESOURCE_WEB_CASH_MIN_TOKENS,
      },
    };
  }

  const clientLocale = typeof body.locale === 'string' ? body.locale : null;
  const countryCode =
    countryHeader?.toUpperCase()
    ?? inferPostResourceBundleOrderCountryFromLocale(clientLocale);
  const priceQuote = await getPostResourceBundlePriceQuote(bundle.price_usd_cents, countryCode);

  let razorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      receipt: buildReceipt(buyerUserId, now),
      notes: {
        bundle_id: bundle.id,
        buyer_user_id: buyerUserId,
        post_id: postId,
      },
    });
  } catch (error) {
    if (isExternalServiceTimeoutError(error)) {
      return { ok: false, status: 504, body: { error: 'Payment provider timed out. Please try again.' } };
    }

    if (error instanceof RazorpayOrderError) {
      return { ok: false, status: error.status as 400 | 404 | 429 | 500 | 502 | 504, body: { error: error.message } };
    }

    throw error;
  }

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay order.' } };
  }

  const { error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .insert({
      bundle_id: bundle.id,
      buyer_user_id: buyerUserId,
      razorpay_order_id: razorpayOrder.id,
      amount_subunits: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      status: 'created',
    });

  if (orderError) {
    logBackendError('failed_to_record_bundle_order', { error: orderError });
    return { ok: false, status: 500, body: { error: 'Failed to record order.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      postId,
      bundleId: bundle.id,
      orderId: razorpayOrder.id,
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      displayPrice: priceQuote.formatted,
      note: priceQuote.note,
      bundleTitle: bundle.title,
    },
  };
}

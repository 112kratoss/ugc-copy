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
  fetchRazorpayOrderByReceipt as defaultFetchRazorpayOrderByReceipt,
  RazorpayOrderError,
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';
import {
  claimRazorpayCheckoutIntent,
  createOrRecoverRazorpayCheckoutOrder,
  RazorpayCheckoutIntentError,
} from '@/lib/razorpay-checkout-intents';
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

type CashQuoteResult = {
  status: string;
  bundle_id?: string;
  post_id?: string;
  owner_user_id?: string;
  title?: string;
  price_usd_cents?: number;
  revision_id?: string;
  content_fingerprint?: string;
};

type CashOrderRecordResult = {
  status: string;
  order_id?: string;
};

type ReadOrderBody = () => Promise<{
  clientIntentKey?: string | null;
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
      status: 400 | 404 | 409 | 429 | 500 | 502 | 504;
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
  fetchRazorpayOrderByReceipt?: typeof defaultFetchRazorpayOrderByReceipt;
  getBundleForOrderByPostId?: GetBundleForOrderByPostId;
  getPostResourceBundlePriceQuote?: (
    priceUsdCents: number,
    countryCode?: string | null,
  ) => Promise<MarketplacePriceQuote>;
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

function rpcObject<T extends { status: string }>(value: unknown): T | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const status = (candidate as { status?: unknown }).status;
  return typeof status === 'string' ? candidate as T : null;
}

async function getAuthoritativeCashQuote(
  adminSupabase: SupabaseClient,
  postId: string,
  buyerUserId: string,
): Promise<CashQuoteResult> {
  const { data, error } = await adminSupabase.rpc('get_post_resource_bundle_cash_quote', {
    p_post_id: postId,
    p_buyer_user_id: buyerUserId,
  });
  if (error) throw error;
  const result = rpcObject<CashQuoteResult>(data);
  if (!result) throw new Error('Invalid post resource cash quote response.');
  return result;
}

async function recordCashOrderQuote(
  adminSupabase: SupabaseClient,
  input: {
    postId: string;
    bundleId: string;
    buyerUserId: string;
    providerOrderId: string;
    amountSubunits: number;
    currency: string;
    priceUsdCents: number;
    revisionId: string;
    contentFingerprint: string;
  },
): Promise<CashOrderRecordResult> {
  const { data, error } = await adminSupabase.rpc('record_post_resource_bundle_cash_order', {
    p_post_id: input.postId,
    p_bundle_id: input.bundleId,
    p_buyer_user_id: input.buyerUserId,
    p_razorpay_order_id: input.providerOrderId,
    p_amount_subunits: input.amountSubunits,
    p_currency: input.currency,
    p_expected_price_usd_cents: input.priceUsdCents,
    p_expected_revision_id: input.revisionId,
    p_expected_content_fingerprint: input.contentFingerprint,
  });
  if (error) throw error;
  const result = rpcObject<CashOrderRecordResult>(data);
  if (!result) throw new Error('Invalid post resource cash order response.');
  return result;
}

export async function createPostResourceBundleOrderForRoute({
  adminSupabase,
  postId,
  buyerUserId,
  countryHeader,
  readBody,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  fetchRazorpayOrderByReceipt = defaultFetchRazorpayOrderByReceipt,
  getBundleForOrderByPostId = defaultGetBundleForOrderByPostId as GetBundleForOrderByPostId,
  getPostResourceBundlePriceQuote = defaultGetPostResourceBundlePriceQuote,
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

  let cashQuote: CashQuoteResult;
  try {
    cashQuote = await getAuthoritativeCashQuote(adminSupabase, postId, buyerUserId);
  } catch (error) {
    logBackendError('failed_to_quote_post_resource_bundle_order', { error });
    return { ok: false, status: 500, body: { error: 'Failed to prepare a secure checkout quote.' } };
  }

  if (cashQuote.status === 'already_owned') {
    return { ok: true, body: { success: true, alreadyPurchased: true } };
  }
  if (cashQuote.status === 'not_found') {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }
  if (cashQuote.status === 'owned_by_user') {
    return { ok: false, status: 400, body: { error: 'You already own this unlock.' } };
  }
  if (cashQuote.status === 'free') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Use the free recipe access endpoint for this bundle.' },
    };
  }
  if (cashQuote.status === 'credits_only') {
    const creditCost = typeof cashQuote.price_usd_cents === 'number'
      ? cashQuote.price_usd_cents
      : bundle.price_usd_cents;
    return {
      ok: false,
      status: 400,
      body: {
        error: `Recipes below ${POST_RESOURCE_WEB_CASH_MIN_TOKENS} tokens can only be unlocked with credits.`,
        code: 'CREDITS_ONLY_PRICE',
        creditCost,
        cashMinimumTokens: POST_RESOURCE_WEB_CASH_MIN_TOKENS,
      },
    };
  }

  const quoteIsComplete = cashQuote.status === 'quoted'
    && typeof cashQuote.bundle_id === 'string'
    && cashQuote.bundle_id.length > 0
    && cashQuote.post_id === postId
    && typeof cashQuote.owner_user_id === 'string'
    && typeof cashQuote.title === 'string'
    && typeof cashQuote.price_usd_cents === 'number'
    && isPostResourceWebCashEligible(cashQuote.price_usd_cents)
    && typeof cashQuote.revision_id === 'string'
    && cashQuote.revision_id.length > 0
    && typeof cashQuote.content_fingerprint === 'string'
    && cashQuote.content_fingerprint.length > 0;
  if (!quoteIsComplete) {
    logBackendError('invalid_post_resource_bundle_cash_quote', { status: cashQuote.status });
    return { ok: false, status: 500, body: { error: 'Failed to prepare a secure checkout quote.' } };
  }

  const authoritativeQuote = cashQuote as Required<Omit<CashQuoteResult, 'status'>> & { status: 'quoted' };

  const clientLocale = typeof body.locale === 'string' ? body.locale : null;
  const countryCode =
    countryHeader?.toUpperCase()
    ?? inferPostResourceBundleOrderCountryFromLocale(clientLocale);
  const priceQuote = await getPostResourceBundlePriceQuote(authoritativeQuote.price_usd_cents, countryCode);

  let checkoutIntent: Awaited<ReturnType<typeof claimRazorpayCheckoutIntent>>;
  let razorpayOrder: RazorpayOrderResponse;
  try {
    checkoutIntent = await claimRazorpayCheckoutIntent(adminSupabase, {
      userId: buyerUserId,
      purchaseKind: 'post_resource',
      clientIntentKey: typeof body.clientIntentKey === 'string'
        ? body.clientIntentKey
        : '',
      requestPayload: {
        amount: priceQuote.amountSubunits,
        bundleId: authoritativeQuote.bundle_id,
        contentFingerprint: authoritativeQuote.content_fingerprint,
        currency: priceQuote.currency,
        postId,
        priceUsdCents: authoritativeQuote.price_usd_cents,
        revisionId: authoritativeQuote.revision_id,
      },
    });
    razorpayOrder = await createOrRecoverRazorpayCheckoutOrder({
      adminSupabase,
      claim: checkoutIntent,
      userId: buyerUserId,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      expectedAmount: priceQuote.amountSubunits,
      expectedCurrency: priceQuote.currency,
      fetchProviderOrderByReceipt: fetchRazorpayOrderByReceipt,
      createProviderOrder: (receipt) => createRazorpayOrder({
        keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        keySecret: process.env.RAZORPAY_KEY_SECRET,
        amount: priceQuote.amountSubunits,
        currency: priceQuote.currency,
        receipt,
        notes: {
          bundle_id: authoritativeQuote.bundle_id,
          buyer_user_id: buyerUserId,
          post_id: postId,
          purchase_kind: 'post_resource',
          revision_id: authoritativeQuote.revision_id,
        },
      }),
    });
  } catch (error) {
    if (error instanceof RazorpayCheckoutIntentError) {
      return {
        ok: false,
        status: error.status,
        body: { error: error.message, code: error.code },
      };
    }
    if (isExternalServiceTimeoutError(error)) {
      return { ok: false, status: 504, body: { error: 'Payment provider timed out. Please try again.' } };
    }

    if (error instanceof RazorpayOrderError) {
      return { ok: false, status: error.status as 400 | 404 | 409 | 429 | 500 | 502 | 504, body: { error: error.message } };
    }

    throw error;
  }

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay order.' } };
  }

  let orderRecord: CashOrderRecordResult;
  try {
    orderRecord = await recordCashOrderQuote(adminSupabase, {
      postId,
      bundleId: authoritativeQuote.bundle_id,
      buyerUserId,
      providerOrderId: razorpayOrder.id,
      amountSubunits: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      priceUsdCents: authoritativeQuote.price_usd_cents,
      revisionId: authoritativeQuote.revision_id,
      contentFingerprint: authoritativeQuote.content_fingerprint,
    });
  } catch (error) {
    logBackendError('failed_to_record_bundle_order_quote', { error });
    return { ok: false, status: 500, body: { error: 'Failed to record the secure checkout quote.' } };
  }

  if (orderRecord.status === 'already_owned') {
    return { ok: true, body: { success: true, alreadyPurchased: true } };
  }
  if (orderRecord.status === 'quote_changed' || orderRecord.status === 'not_found') {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'This unlock changed while checkout was opening. Review the latest version and try again.',
        code: 'RESOURCE_QUOTE_CHANGED',
      },
    };
  }
  if (orderRecord.status === 'order_conflict') {
    return {
      ok: false,
      status: 409,
      body: { error: 'Checkout details conflict with the recorded order.' },
    };
  }
  if (orderRecord.status !== 'created' && orderRecord.status !== 'replay') {
    logBackendError('invalid_post_resource_bundle_order_record', { status: orderRecord.status });
    return { ok: false, status: 500, body: { error: 'Failed to record the secure checkout quote.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      postId,
      bundleId: authoritativeQuote.bundle_id,
      orderId: razorpayOrder.id,
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      displayPrice: priceQuote.formatted,
      note: priceQuote.note,
      bundleTitle: authoritativeQuote.title,
    },
  };
}

import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_ORDER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { MarketplacePriceQuote } from '@/lib/marketplace';
import { isPostResourceBundleBuyWithheld as defaultIsPostResourceBundleBuyWithheld } from '@/lib/marketplace-viewer-filter';
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
import {
  AUTHORITATIVE_FEED_EVENT_TIMEOUT_MS,
  recordAuthoritativeFeedEvent,
  type AuthoritativeFeedEventResult,
} from '@/lib/showcase-feed-events-service';

/**
 * A purchase is credited to the delivery the buyer opened the post's
 * resources (or the post) from: their latest `resource_open` or `open` of it
 * within this window.
 */
export const BUNDLE_PURCHASE_DELIVERY_LOOKBACK_HOURS = 24;

/**
 * v4's server-written `purchase` feed event for a settled bundle purchase.
 *
 * Every settlement path calls it once its purchase is recorded — the buyer's
 * own verify, Razorpay's webhook, the app store and credit unlocks — so it is
 * written once per buyer and post however many of them report the same
 * purchase. Given a Razorpay order id it reads the buyer and the post from the
 * order. Telemetry on a payment: it never throws and waits no longer than the
 * feed event timeout, the order read included.
 */
export async function recordPostResourceBundlePurchaseFeedEvent(
  adminSupabase: SupabaseClient,
  purchase: { buyerUserId: string; postId: string } | { razorpayOrderId: string },
  { timeoutMs = AUTHORITATIVE_FEED_EVENT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<AuthoritativeFeedEventResult> {
  const startedAtMs = Date.now();
  let buyerUserId: string;
  let postId: string;
  if ('razorpayOrderId' in purchase) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const order = await Promise.race([
        adminSupabase
          .from('post_resource_bundle_orders')
          .select('buyer_user_id, post_resource_bundles(post_id)')
          .eq('razorpay_order_id', purchase.razorpayOrderId)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) throw error;
            return data as { buyer_user_id?: unknown; post_resource_bundles?: unknown } | null;
          }),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (order === 'timeout') return { status: 'failed', reason: 'timeout' };
      const bundle = Array.isArray(order?.post_resource_bundles)
        ? order.post_resource_bundles[0]
        : order?.post_resource_bundles;
      const bundlePostId = bundle && typeof bundle === 'object' ? (bundle as { post_id?: unknown }).post_id : null;
      if (typeof order?.buyer_user_id !== 'string' || typeof bundlePostId !== 'string') {
        return { status: 'skipped', reason: 'invalid_input' };
      }
      buyerUserId = order.buyer_user_id;
      postId = bundlePostId;
    } catch (error) {
      logBackendError('failed_to_load_bundle_order_for_feed_event', { error });
      return { status: 'failed', reason: 'error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } else {
    ({ buyerUserId, postId } = purchase);
  }

  return recordAuthoritativeFeedEvent(adminSupabase, {
    eventType: 'purchase',
    viewerUserId: buyerUserId,
    postId,
    // A bundle is bought once per buyer: every settlement path's report is the one purchase.
    actionKey: `${buyerUserId}:${postId}`,
    inferDeliveryFrom: {
      eventTypes: ['resource_open', 'open'],
      withinHours: BUNDLE_PURCHASE_DELIVERY_LOOKBACK_HOURS,
    },
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAtMs)),
  });
}

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

type ReadOrderBody = () => Promise<unknown>;

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
  isPostResourceBundleBuyWithheld?: typeof defaultIsPostResourceBundleBuyWithheld;
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
  isPostResourceBundleBuyWithheld = defaultIsPostResourceBundleBuyWithheld,
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

  let decoded: unknown;
  try {
    decoded = await readBody();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, status: 400, body: { error: 'Invalid checkout request.' } };
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ok: false, status: 400, body: { error: 'Invalid checkout request.' } };
  }
  const body = decoded as { clientIntentKey?: unknown; locale?: unknown };
  const bundle = await getBundleForOrderByPostId(postId);
  if (!bundle || bundle.status !== 'published') {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
  }

  if (bundle.owner_user_id === buyerUserId) {
    return { ok: false, status: 400, body: { error: 'You already own this unlock.' } };
  }

  // The quote and order RPCs check only the bundle's status. What the detail
  // read would not show this buyer, or a creator either of them has blocked,
  // is answered as a missing unlock: no provider order, so no payment and no
  // sale to notify.
  let withheld: boolean;
  try {
    withheld = await isPostResourceBundleBuyWithheld({ adminSupabase, buyerUserId, postId });
  } catch (error) {
    logBackendError('failed_to_check_post_resource_order_buyer_access', { error });
    return { ok: false, status: 500, body: { error: 'Failed to prepare a secure checkout quote.' } };
  }
  if (withheld) {
    return { ok: false, status: 404, body: { error: 'Unlock not found.' } };
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
        error: `Recipes below ${POST_RESOURCE_WEB_CASH_MIN_TOKENS} credits can only be unlocked with credits.`,
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
        error: `Recipes below ${POST_RESOURCE_WEB_CASH_MIN_TOKENS} credits can only be unlocked with credits.`,
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

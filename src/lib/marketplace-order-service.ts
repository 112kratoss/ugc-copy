import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  MARKETPLACE_ORDER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  getMarketplacePriceQuote as defaultGetMarketplacePriceQuote,
} from '@/lib/marketplace-server';
import type { MarketplacePriceQuote } from '@/lib/marketplace';
import {
  createRazorpayOrder as defaultCreateRazorpayOrder,
  fetchRazorpayOrderByReceipt as defaultFetchRazorpayOrderByReceipt,
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';
import {
  claimRazorpayCheckoutIntent,
  createOrRecoverRazorpayCheckoutOrder,
  RazorpayCheckoutIntentError,
} from '@/lib/razorpay-checkout-intents';

type MarketplaceOrderAssetRow = {
  id: string;
  title: string;
  price_usd_cents: number;
  status: 'draft' | 'active' | 'unlisted' | 'deleted';
  seller_user_id: string;
};

export type MarketplaceOrderRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 500;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreateRazorpayOrder = (input: {
  keyId?: string | null;
  keySecret?: string | null;
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}) => Promise<RazorpayOrderResponse>;

type CreateMarketplaceOrderParams = {
  adminSupabase: SupabaseClient;
  assetId: string;
  buyerUserId: string;
  clientIntentKey: string;
  countryCode: string | null;
  createRazorpayOrder?: CreateRazorpayOrder;
  fetchRazorpayOrderByReceipt?: typeof defaultFetchRazorpayOrderByReceipt;
  getMarketplacePriceQuote?: (priceUsdCents: number, countryCode?: string | null) => Promise<MarketplacePriceQuote>;
  randomId?: () => string;
};

export function inferMarketplaceOrderCountryFromLocale(locale: string | null): string | null {
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

function createRateLimitResult(error: BackendRateLimitError): MarketplaceOrderRouteResult {
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

export async function createMarketplaceOrderForRoute({
  adminSupabase,
  assetId,
  buyerUserId,
  clientIntentKey,
  countryCode,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  fetchRazorpayOrderByReceipt = defaultFetchRazorpayOrderByReceipt,
  getMarketplacePriceQuote = defaultGetMarketplacePriceQuote,
  randomId = randomUUID,
}: CreateMarketplaceOrderParams): Promise<MarketplaceOrderRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...MARKETPLACE_ORDER_RATE_LIMIT,
      key: buyerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('marketplace_order_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check marketplace order limits.' },
    };
  }

  const { data: assetData, error: assetError } = await adminSupabase
    .from('marketplace_assets')
    .select('id, title, price_usd_cents, status, seller_user_id')
    .eq('id', assetId)
    .maybeSingle();

  if (assetError) {
    logBackendError('failed_to_load_marketplace_asset_for_order', { error: assetError });
    return { ok: false, status: 500, body: { error: 'Failed to load listing.' } };
  }

  const asset = (assetData as MarketplaceOrderAssetRow | null) ?? null;
  if (!asset || (asset.status !== 'active' && asset.status !== 'unlisted')) {
    return { ok: false, status: 404, body: { error: 'Listing not found.' } };
  }

  if (asset.seller_user_id === buyerUserId) {
    return { ok: false, status: 400, body: { error: 'You already own this listing.' } };
  }

  const { data: existingPurchase, error: existingPurchaseError } = await adminSupabase
    .from('marketplace_purchases')
    .select('asset_id')
    .eq('asset_id', assetId)
    .eq('buyer_user_id', buyerUserId)
    .maybeSingle();

  if (existingPurchaseError) {
    logBackendError('failed_to_check_existing_purchase', { error: existingPurchaseError });
    return { ok: false, status: 500, body: { error: 'Failed to check purchase history.' } };
  }

  if (existingPurchase) {
    return {
      ok: true,
      body: { success: true, alreadyPurchased: true },
    };
  }

  if (asset.price_usd_cents === 0) {
    // One atomic RPC instead of the old insert-then-complete dance: the asset
    // row lock plus the (asset_id, buyer_user_id) purchase constraint make a
    // concurrent double-unlock converge on `already_owned` instead of
    // stranding a duplicate order.
    const { data: unlockData, error: unlockError } = await adminSupabase.rpc('unlock_free_marketplace_asset', {
      p_buyer_user_id: buyerUserId,
      p_asset_id: assetId,
      p_order_reference: `free_${randomId()}`,
      p_payment_reference: `free_unlock_${randomId()}`,
    });

    if (unlockError) {
      logBackendError('failed_to_unlock_free_marketplace_asset', { error: unlockError });
      return { ok: false, status: 500, body: { error: 'Failed to unlock free listing.' } };
    }

    const unlockCandidate = Array.isArray(unlockData) ? unlockData[0] : unlockData;
    const unlockStatus = unlockCandidate && typeof unlockCandidate === 'object' && !Array.isArray(unlockCandidate)
      ? String((unlockCandidate as { status?: unknown }).status ?? '')
      : '';

    if (unlockStatus === 'already_owned') {
      return { ok: true, body: { success: true, alreadyPurchased: true } };
    }
    if (unlockStatus === 'owned_by_user') {
      return { ok: false, status: 400, body: { error: 'You already own this listing.' } };
    }
    if (unlockStatus === 'not_found') {
      return { ok: false, status: 404, body: { error: 'Listing not found.' } };
    }
    if (unlockStatus === 'not_free') {
      return { ok: false, status: 409, body: { error: 'This listing is no longer free.' } };
    }
    if (unlockStatus !== 'completed') {
      logBackendError('unexpected_free_marketplace_unlock_status', { status: unlockStatus });
      return { ok: false, status: 500, body: { error: 'Failed to unlock free listing.' } };
    }

    return {
      ok: true,
      body: {
        success: true,
        free: true,
        alreadyProcessed: false,
      },
    };
  }

  const priceQuote = await getMarketplacePriceQuote(asset.price_usd_cents, countryCode);
  let checkoutIntent: Awaited<ReturnType<typeof claimRazorpayCheckoutIntent>>;
  let razorpayOrder: RazorpayOrderResponse;
  try {
    checkoutIntent = await claimRazorpayCheckoutIntent(adminSupabase, {
      userId: buyerUserId,
      purchaseKind: 'marketplace',
      clientIntentKey,
      requestPayload: {
        amount: priceQuote.amountSubunits,
        assetId: asset.id,
        currency: priceQuote.currency,
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
          asset_id: asset.id,
          buyer_user_id: buyerUserId,
          purchase_kind: 'marketplace',
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
    throw error;
  }

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay order.' } };
  }

  if (checkoutIntent.status === 'replay') {
    const { data: existingOrder, error: existingOrderError } = await adminSupabase
      .from('marketplace_orders')
      .select('asset_id, buyer_user_id, amount_subunits, currency')
      .eq('razorpay_order_id', razorpayOrder.id)
      .maybeSingle();
    if (existingOrderError) {
      logBackendError('failed_to_load_replayed_marketplace_order', { error: existingOrderError });
      return { ok: false, status: 500, body: { error: 'Failed to load order.' } };
    }
    if (existingOrder) {
      if (
        existingOrder.asset_id !== asset.id
        || existingOrder.buyer_user_id !== buyerUserId
        || existingOrder.amount_subunits !== priceQuote.amountSubunits
        || existingOrder.currency !== priceQuote.currency
      ) {
        return { ok: false, status: 409, body: { error: 'Checkout details conflict with the recorded order.' } };
      }
      return {
        ok: true,
        body: {
          success: true,
          assetId: asset.id,
          orderId: razorpayOrder.id,
          amount: priceQuote.amountSubunits,
          currency: priceQuote.currency,
          displayPrice: priceQuote.formatted,
          note: priceQuote.note,
          listingTitle: asset.title,
        },
      };
    }
  }

  const { error: orderInsertError } = await adminSupabase
    .from('marketplace_orders')
    .insert({
      asset_id: asset.id,
      buyer_user_id: buyerUserId,
      razorpay_order_id: razorpayOrder.id,
      amount_subunits: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      status: 'created',
    });

  if (orderInsertError) {
    if (orderInsertError.code === '23505') {
      const { data: existingOrder } = await adminSupabase
        .from('marketplace_orders')
        .select('asset_id, buyer_user_id, amount_subunits, currency')
        .eq('razorpay_order_id', razorpayOrder.id)
        .maybeSingle();
      if (
        existingOrder?.asset_id === asset.id
        && existingOrder.buyer_user_id === buyerUserId
        && existingOrder.amount_subunits === priceQuote.amountSubunits
        && existingOrder.currency === priceQuote.currency
      ) {
        return {
          ok: true,
          body: {
            success: true,
            assetId: asset.id,
            orderId: razorpayOrder.id,
            amount: priceQuote.amountSubunits,
            currency: priceQuote.currency,
            displayPrice: priceQuote.formatted,
            note: priceQuote.note,
            listingTitle: asset.title,
          },
        };
      }
    }
    logBackendError('failed_to_record_marketplace_order', { error: orderInsertError });
    return { ok: false, status: 500, body: { error: 'Failed to record order.' } };
  }

  return {
    ok: true,
    body: {
      success: true,
      assetId: asset.id,
      orderId: razorpayOrder.id,
      amount: priceQuote.amountSubunits,
      currency: priceQuote.currency,
      displayPrice: priceQuote.formatted,
      note: priceQuote.note,
      listingTitle: asset.title,
    },
  };
}

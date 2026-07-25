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
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';

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
      status: 400 | 404 | 429 | 500;
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
  countryCode: string | null;
  createRazorpayOrder?: CreateRazorpayOrder;
  getMarketplacePriceQuote?: (priceUsdCents: number, countryCode?: string | null) => Promise<MarketplacePriceQuote>;
  now?: () => number;
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

function buildReceipt(userId: string, now: () => number) {
  return `mkt_${userId.slice(0, 8)}_${now()}`;
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
  countryCode,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  getMarketplacePriceQuote = defaultGetMarketplacePriceQuote,
  now = Date.now,
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
    const freeOrderId = `free_${randomId()}`;
    const { error: orderError } = await adminSupabase
      .from('marketplace_orders')
      .insert({
        asset_id: assetId,
        buyer_user_id: buyerUserId,
        razorpay_order_id: freeOrderId,
        razorpay_payment_id: `free_${randomId()}`,
        amount_subunits: 0,
        currency: 'USD',
        status: 'created',
      });

    if (orderError) {
      logBackendError('failed_to_create_free_marketplace_order', { error: orderError });
      return { ok: false, status: 500, body: { error: 'Failed to unlock free listing.' } };
    }

    const { data: completed, error: completionError } = await adminSupabase.rpc('complete_marketplace_purchase', {
      p_razorpay_order_id: freeOrderId,
      p_razorpay_payment_id: `free_unlock_${randomId()}`,
    });

    if (completionError) {
      logBackendError('failed_to_complete_free_marketplace_purchase', { error: completionError });
      return { ok: false, status: 500, body: { error: 'Failed to unlock free listing.' } };
    }

    return {
      ok: true,
      body: {
        success: true,
        free: true,
        alreadyProcessed: !completed,
      },
    };
  }

  const priceQuote = await getMarketplacePriceQuote(asset.price_usd_cents, countryCode);
  const razorpayOrder = await createRazorpayOrder({
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    amount: priceQuote.amountSubunits,
    currency: priceQuote.currency,
    receipt: buildReceipt(buyerUserId, now),
    notes: {
      asset_id: asset.id,
      buyer_user_id: buyerUserId,
    },
  });

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay order.' } };
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

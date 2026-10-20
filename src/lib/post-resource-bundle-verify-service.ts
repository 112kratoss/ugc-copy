import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_ORDER_VERIFY_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { sendDeferrableNotification, type RunAfterResponse } from '@/lib/deferrable-notification';
import { invalidateMarketplaceResourceListCache as defaultInvalidateMarketplaceResourceListCache } from '@/lib/marketplace-resource-list-cache';
import { notifyPostResourceUnlockCompleted } from '@/lib/mobile-notifications';
import { recordPostResourceBundlePurchaseFeedEvent } from '@/lib/post-resource-bundle-order-service';
import {
  createPendingPaymentResultBody,
  verifyRazorpayPaymentAgainstOrder,
} from '@/lib/razorpay-payment-verification';
import {
  fetchRazorpayPayment as defaultFetchRazorpayPayment,
  RazorpayPaymentError,
} from '@/lib/razorpay-orders';
import { verifyRazorpayPaymentSignature } from '@/lib/razorpay-signature';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';

type PostResourceBundleOrderRow = {
  id: string;
  buyer_user_id: string;
  amount_subunits: number;
  currency: string;
  razorpay_payment_id?: string | null;
  status: 'created' | 'paid' | 'failed' | string;
};

type PostResourceBundleVerifyBody = {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
};

export type PostResourceBundleVerifyRouteResult =
  | {
      ok: true;
      status?: 200 | 202;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500 | 502 | 503 | 504;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBody(value: unknown): PostResourceBundleVerifyBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PostResourceBundleVerifyBody
    : {};
}

/**
 * Tells the buyer and the owner about a recipe bought through Razorpay, as a
 * purchase in the app is told ("Post resources unlocked"; "You made a sale",
 * naming the buyer). A checkout names its order alone, so the post and its
 * owner are read from it. Whichever of the buyer's verify and the webhook
 * settled the order calls this, once; the alerts' dedupe keys make a second
 * call harmless. Never rejects: the purchase is settled whatever becomes of
 * its alerts.
 */
export async function notifyRazorpayPostResourcePurchase(
  adminSupabase: SupabaseClient,
  razorpayOrderId: string,
) {
  try {
    const { data, error } = await adminSupabase
      .from('post_resource_bundle_orders')
      .select('bundle_id, buyer_user_id, post_resource_bundles(post_id, owner_user_id)')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();
    if (error) throw error;

    const order = data as { bundle_id?: unknown; buyer_user_id?: unknown; post_resource_bundles?: unknown } | null;
    const bundle = (Array.isArray(order?.post_resource_bundles)
      ? order.post_resource_bundles[0]
      : order?.post_resource_bundles) as { post_id?: unknown; owner_user_id?: unknown } | null | undefined;
    if (
      typeof order?.bundle_id !== 'string'
      || typeof order.buyer_user_id !== 'string'
      || typeof bundle?.post_id !== 'string'
      || typeof bundle.owner_user_id !== 'string'
    ) {
      logBackendError('razorpay_post_resource_notification_order_unreadable', { razorpayOrderId });
      return null;
    }

    return await notifyPostResourceUnlockCompleted(adminSupabase, {
      buyerUserId: order.buyer_user_id,
      ownerUserId: bundle.owner_user_id,
      postId: bundle.post_id,
      bundleId: order.bundle_id,
      alreadyProcessed: false,
    });
  } catch (error) {
    logBackendError('razorpay_post_resource_notification_failed', { razorpayOrderId, error });
    return null;
  }
}

export async function verifyPostResourceBundlePaymentForRoute({
  adminSupabase,
  buyerUserId,
  keyId,
  keySecret,
  readBody,
  verifySignature = verifyRazorpayPaymentSignature,
  fetchPayment = defaultFetchRazorpayPayment,
  invalidateMarketplaceResourceListCache = defaultInvalidateMarketplaceResourceListCache,
  recordPurchaseFeedEvent = recordPostResourceBundlePurchaseFeedEvent,
  notifyPurchase = notifyRazorpayPostResourcePurchase,
  runAfterResponse,
}: {
  adminSupabase: SupabaseClient;
  buyerUserId: string;
  keyId?: string | null;
  keySecret?: string | null;
  readBody: () => Promise<unknown>;
  verifySignature?: typeof verifyRazorpayPaymentSignature;
  fetchPayment?: typeof defaultFetchRazorpayPayment;
  invalidateMarketplaceResourceListCache?: () => void;
  recordPurchaseFeedEvent?: typeof recordPostResourceBundlePurchaseFeedEvent;
  notifyPurchase?: typeof notifyRazorpayPostResourcePurchase;
  /**
   * Runs a task once the caller has answered. With one, the purchase's alerts
   * go out behind the checkout's answer; without one they are sent before
   * this returns.
   */
  runAfterResponse?: RunAfterResponse;
}): Promise<PostResourceBundleVerifyRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...POST_RESOURCE_ORDER_VERIFY_RATE_LIMIT,
      key: buyerUserId,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
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

    logBackendError('failed_to_enforce_post_resource_verification_rate_limit', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to verify order.' } };
  }

  const body = normalizeBody(await readBody().catch((error: unknown) => {
    if (error instanceof SyntaxError) return null;
    throw error;
  }));
  const razorpayOrderId = normalizeString(body.razorpay_order_id);
  const razorpayPaymentId = normalizeString(body.razorpay_payment_id);
  const razorpaySignature = normalizeString(body.razorpay_signature);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return { ok: false, status: 400, body: { error: 'Missing required payment parameters.' } };
  }

  const resolvedKeyId = keyId?.trim();
  const secret = keySecret?.trim();
  if (!resolvedKeyId || !secret) {
    logBackendError('razorpay_api_credentials_not_configured');
    return { ok: false, status: 503, body: { error: 'Payment verification is not configured.' } };
  }

  if (!verifySignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
    secret,
  })) {
    return { ok: false, status: 400, body: { error: 'Invalid payment signature.' } };
  }

  const { data: orderData, error: orderError } = await adminSupabase
    .from('post_resource_bundle_orders')
    .select('id, buyer_user_id, amount_subunits, currency, status, razorpay_payment_id')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (orderError) {
    logBackendError('failed_to_load_bundle_order_for_verification', { error: orderError });
    return { ok: false, status: 500, body: { error: 'Failed to verify order.' } };
  }

  const order = (orderData as PostResourceBundleOrderRow | null) ?? null;
  if (!order || order.buyer_user_id !== buyerUserId) {
    return { ok: false, status: 404, body: { error: 'Order not found.' } };
  }

  if (order.status === 'paid' && order.razorpay_payment_id !== razorpayPaymentId) {
    logBackendError('post_resource_verify_payment_id_conflict', {
      orderId: razorpayOrderId,
      resourceOrderId: order.id,
    });
    return { ok: false, status: 400, body: { error: 'Payment details do not match the order.' } };
  }
  if (order.status === 'failed') {
    return { ok: false, status: 400, body: { error: 'This order cannot be fulfilled.' } };
  }

  let payment;
  try {
    payment = await fetchPayment({
      keyId: resolvedKeyId,
      keySecret: secret,
      paymentId: razorpayPaymentId,
    });
  } catch (error) {
    logBackendError('post_resource_payment_lookup_failed', {
      orderId: razorpayOrderId,
      error,
    });
    if (isExternalServiceTimeoutError(error)) {
      return { ok: false, status: 504, body: { error: 'Payment provider timed out. Please try again.' } };
    }
    if (error instanceof RazorpayPaymentError) {
      return {
        ok: false,
        status: error.status as 400 | 500 | 502,
        body: { error: error.status === 400 ? 'Payment could not be verified.' : 'Payment provider is unavailable.' },
      };
    }
    return { ok: false, status: 502, body: { error: 'Payment provider is unavailable.' } };
  }

  const paymentVerification = verifyRazorpayPaymentAgainstOrder({
    payment,
    expectedPaymentId: razorpayPaymentId,
    expectedOrderId: razorpayOrderId,
    expectedAmount: order.amount_subunits,
    expectedCurrency: order.currency,
    expectedBuyerUserId: buyerUserId,
    buyerNoteKey: 'buyer_user_id',
  });
  if (paymentVerification.state === 'pending') {
    return {
      ok: true,
      status: 202,
      body: createPendingPaymentResultBody(),
    };
  }
  if (paymentVerification.state === 'rejected') {
    logBackendError('post_resource_payment_validation_failed', {
      orderId: razorpayOrderId,
      reason: paymentVerification.reason,
    });
    return { ok: false, status: 400, body: { error: 'Payment details do not match the order.' } };
  }

  if (order.status === 'paid') {
    return { ok: true, body: { success: true, alreadyProcessed: true } };
  }

  const { data: completionResult, error: completionError } = await adminSupabase.rpc(
    'complete_post_resource_bundle_purchase',
    {
      p_razorpay_order_id: razorpayOrderId,
      p_razorpay_payment_id: razorpayPaymentId,
    }
  );

  if (completionError) {
    logBackendError('failed_to_complete_bundle_purchase', { error: completionError });
    return { ok: false, status: 500, body: { error: 'Failed to complete purchase.' } };
  }

  if (!completionResult) {
    const { data: refreshedOrder } = await adminSupabase
      .from('post_resource_bundle_orders')
      .select('status, razorpay_payment_id')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();

    if (refreshedOrder?.status === 'failed' || refreshedOrder?.status === 'refunded') {
      return { ok: false, status: 400, body: { error: 'This order cannot be fulfilled.' } };
    }

    if (
      refreshedOrder?.status === 'paid'
      && refreshedOrder.razorpay_payment_id === razorpayPaymentId
    ) {
      return { ok: true, body: { success: true, alreadyProcessed: true } };
    }

    return { ok: false, status: 500, body: { error: 'Unable to finalize purchase.' } };
  }

  invalidateMarketplaceResourceListCache();
  // The purchase is settled. Its feed event never fails this answer and holds
  // it no longer than the event's short timeout.
  await recordPurchaseFeedEvent(adminSupabase, { razorpayOrderId });
  // This call settled the order, so its alerts are sent from here; when the
  // webhook settles one, the webhook sends them.
  await sendDeferrableNotification(runAfterResponse, () => notifyPurchase(adminSupabase, razorpayOrderId));

  return { ok: true, body: { success: true } };
}

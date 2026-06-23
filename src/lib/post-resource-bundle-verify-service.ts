import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  POST_RESOURCE_ORDER_VERIFY_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { verifyRazorpayPaymentSignature } from '@/lib/razorpay-signature';

type PostResourceBundleOrderRow = {
  id: string;
  buyer_user_id: string;
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
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 404 | 429 | 500 | 503;
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

export async function verifyPostResourceBundlePaymentForRoute({
  adminSupabase,
  buyerUserId,
  keySecret,
  readBody,
  verifySignature = verifyRazorpayPaymentSignature,
}: {
  adminSupabase: SupabaseClient;
  buyerUserId: string;
  keySecret?: string | null;
  readBody: () => Promise<unknown>;
  verifySignature?: typeof verifyRazorpayPaymentSignature;
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

    console.error('Failed to enforce post resource verification rate limit:', error);
    return { ok: false, status: 500, body: { error: 'Failed to verify order.' } };
  }

  const body = normalizeBody(await readBody());
  const razorpayOrderId = normalizeString(body.razorpay_order_id);
  const razorpayPaymentId = normalizeString(body.razorpay_payment_id);
  const razorpaySignature = normalizeString(body.razorpay_signature);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return { ok: false, status: 400, body: { error: 'Missing required payment parameters.' } };
  }

  const secret = keySecret?.trim();
  if (!secret) {
    console.error('RAZORPAY_KEY_SECRET not configured');
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
    .select('id, buyer_user_id, status')
    .eq('razorpay_order_id', razorpayOrderId)
    .maybeSingle();

  if (orderError) {
    console.error('Failed to load bundle order for verification:', orderError);
    return { ok: false, status: 500, body: { error: 'Failed to verify order.' } };
  }

  const order = (orderData as PostResourceBundleOrderRow | null) ?? null;
  if (!order || order.buyer_user_id !== buyerUserId) {
    return { ok: false, status: 404, body: { error: 'Order not found.' } };
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
    console.error('Failed to complete bundle purchase:', completionError);
    return { ok: false, status: 500, body: { error: 'Failed to complete purchase.' } };
  }

  if (!completionResult) {
    const { data: refreshedOrder } = await adminSupabase
      .from('post_resource_bundle_orders')
      .select('status')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();

    if (refreshedOrder?.status === 'paid') {
      return { ok: true, body: { success: true, alreadyProcessed: true } };
    }

    return { ok: false, status: 500, body: { error: 'Unable to finalize purchase.' } };
  }

  return { ok: true, body: { success: true } };
}

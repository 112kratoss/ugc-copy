import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CREDIT_ORDER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  createRazorpayOrder as defaultCreateRazorpayOrder,
  RazorpayOrderError,
  type RazorpayOrderResponse,
} from '@/lib/razorpay-orders';

export type CreditOrderPlan = {
  priceInr: number;
  credits: number;
};

export type CreditRazorpayOrderRouteResult =
  | {
      ok: true;
      body: {
        orderId: string;
        amount: number;
        currency: 'INR';
      };
    }
  | {
      ok: false;
      status: 429 | 500 | 502 | 504;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreateCreditRazorpayOrder = (input: {
  keyId?: string | null;
  keySecret?: string | null;
  amount: number;
  currency: string;
  receipt: string;
}) => Promise<RazorpayOrderResponse>;

function buildReceipt(userId: string, now: () => number) {
  return `rcpt_${userId.substring(0, 8)}_${now()}`;
}

export async function createCreditRazorpayOrderForRoute({
  adminSupabase,
  userId,
  plan,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  now = Date.now,
}: {
  adminSupabase: SupabaseClient;
  userId: string;
  plan: CreditOrderPlan;
  createRazorpayOrder?: CreateCreditRazorpayOrder;
  now?: () => number;
}): Promise<CreditRazorpayOrderRouteResult> {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...CREDIT_ORDER_RATE_LIMIT,
      key: userId,
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

    console.error('Credit order rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check credit order limits.' } };
  }

  const amountInSubunits = plan.priceInr * 100;
  let razorpayOrder: RazorpayOrderResponse;

  try {
    razorpayOrder = await createRazorpayOrder({
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      amount: amountInSubunits,
      currency: 'INR',
      receipt: buildReceipt(userId, now),
    });
  } catch (error) {
    console.error('Razorpay Order Error:', error);
    if (isExternalServiceTimeoutError(error)) {
      return { ok: false, status: 504, body: { error: 'Payment provider timed out. Please try again.' } };
    }

    if (error instanceof RazorpayOrderError) {
      return { ok: false, status: error.status as 500 | 502, body: { error: error.message } };
    }

    return {
      ok: false,
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Internal Server Error' },
    };
  }

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay Order' } };
  }

  const { data: txnData, error: txnError } = await adminSupabase
    .from('transactions')
    .insert({
      user_id: userId,
      razorpay_order_id: razorpayOrder.id,
      amount: amountInSubunits,
      credits: plan.credits,
      status: 'created',
    })
    .select('id')
    .single();

  if (txnError || !txnData) {
    console.error('Supabase transaction insert error:', txnError);
    return { ok: false, status: 500, body: { error: 'Failed to record transaction' } };
  }

  return {
    ok: true,
    body: {
      orderId: razorpayOrder.id,
      amount: amountInSubunits,
      currency: 'INR',
    },
  };
}

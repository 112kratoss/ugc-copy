import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CREDIT_ORDER_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  claimRazorpayCheckoutIntent,
  createOrRecoverRazorpayCheckoutOrder,
  RazorpayCheckoutIntentError,
} from '@/lib/razorpay-checkout-intents';
import {
  createRazorpayOrder as defaultCreateRazorpayOrder,
  fetchRazorpayOrderByReceipt as defaultFetchRazorpayOrderByReceipt,
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
      status: 400 | 409 | 429 | 500 | 502 | 504;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

type CreateCreditRazorpayOrder = (input: {
  keyId?: string | null;
  keySecret?: string | null;
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}) => Promise<RazorpayOrderResponse>;

export async function createCreditRazorpayOrderForRoute({
  adminSupabase,
  clientIntentKey,
  userId,
  plan,
  createRazorpayOrder = defaultCreateRazorpayOrder,
  fetchRazorpayOrderByReceipt = defaultFetchRazorpayOrderByReceipt,
}: {
  adminSupabase: SupabaseClient;
  clientIntentKey: string;
  userId: string;
  plan: CreditOrderPlan;
  createRazorpayOrder?: CreateCreditRazorpayOrder;
  fetchRazorpayOrderByReceipt?: typeof defaultFetchRazorpayOrderByReceipt;
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

    logBackendError('credit_order_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check credit order limits.' } };
  }

  const amountInSubunits = plan.priceInr * 100;
  let razorpayOrder: RazorpayOrderResponse;
  let checkoutIntent: Awaited<ReturnType<typeof claimRazorpayCheckoutIntent>>;

  try {
    checkoutIntent = await claimRazorpayCheckoutIntent(adminSupabase, {
      userId,
      purchaseKind: 'credits',
      clientIntentKey,
      requestPayload: {
        amount: amountInSubunits,
        credits: plan.credits,
        currency: 'INR',
      },
    });
    razorpayOrder = await createOrRecoverRazorpayCheckoutOrder({
      adminSupabase,
      claim: checkoutIntent,
      userId,
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      keySecret: process.env.RAZORPAY_KEY_SECRET,
      expectedAmount: amountInSubunits,
      expectedCurrency: 'INR',
      fetchProviderOrderByReceipt: fetchRazorpayOrderByReceipt,
      createProviderOrder: (receipt) => createRazorpayOrder({
        keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        keySecret: process.env.RAZORPAY_KEY_SECRET,
        amount: amountInSubunits,
        currency: 'INR',
        receipt,
        notes: {
          user_id: userId,
          purchase_kind: 'credits',
        },
      }),
    });
  } catch (error) {
    logBackendError('razorpay_order_error', { error: error });
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
      return { ok: false, status: error.status as 500 | 502, body: { error: error.message } };
    }

    return {
      ok: false,
      status: 500,
      body: { error: 'Unable to create payment order. Please try again.' },
    };
  }

  if (!razorpayOrder?.id) {
    return { ok: false, status: 500, body: { error: 'Failed to create Razorpay Order' } };
  }

  if (checkoutIntent?.status === 'replay') {
    const { data: existingTransaction, error: existingError } = await adminSupabase
      .from('transactions')
      .select('user_id, amount, credits')
      .eq('razorpay_order_id', razorpayOrder.id)
      .maybeSingle();
    if (existingError) {
      logBackendError('supabase_transaction_replay_load_error', { error: existingError });
      return { ok: false, status: 500, body: { error: 'Failed to load transaction' } };
    }
    if (existingTransaction) {
      if (
        existingTransaction.user_id !== userId
        || existingTransaction.amount !== amountInSubunits
        || existingTransaction.credits !== plan.credits
      ) {
        logBackendError('razorpay_transaction_replay_mismatch', { orderId: razorpayOrder.id });
        return { ok: false, status: 409, body: { error: 'Checkout details conflict with the recorded order.' } };
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
  }

  const { data: txnData, error: txnError } = await adminSupabase
    .from('transactions')
    .insert({
      user_id: userId,
      razorpay_order_id: razorpayOrder.id,
      amount: amountInSubunits,
      credits: plan.credits,
      currency: 'INR',
      status: 'created',
    })
    .select('id')
    .single();

  if (txnError || !txnData) {
    if (txnError?.code === '23505') {
      const { data: existingTransaction } = await adminSupabase
        .from('transactions')
        .select('id, user_id, amount, credits')
        .eq('razorpay_order_id', razorpayOrder.id)
        .maybeSingle();
      if (
        existingTransaction?.user_id === userId
        && existingTransaction.amount === amountInSubunits
        && existingTransaction.credits === plan.credits
      ) {
        return {
          ok: true,
          body: {
            orderId: razorpayOrder.id,
            amount: amountInSubunits,
            currency: 'INR',
          },
        };
      }
    }
    logBackendError('supabase_transaction_insert_error', { error: txnError });
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

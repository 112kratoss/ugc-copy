import 'server-only';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CREDIT_ORDER_VERIFY_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { settleCreditPurchaseReferralRewards } from '@/lib/credit-referral-integration';
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

type CreditVerifyBody = {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
  userId?: unknown;
};

type CreditTransactionRow = {
  id: string;
  user_id: string;
  credits: number;
  amount: number;
  razorpay_payment_id?: string | null;
  credit_effect_applied?: boolean;
  status: 'created' | 'success' | 'failed' | string;
};

export type CreditRazorpayVerifyRouteResult =
  | {
      ok: true;
      status?: 200 | 202;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 401 | 404 | 429 | 500 | 502 | 503 | 504;
      body: Record<string, unknown>;
      rateLimitError?: BackendRateLimitError;
    };

function normalizeString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBody(value: unknown): CreditVerifyBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CreditVerifyBody
    : {};
}

export async function verifyCreditRazorpayPaymentForRoute({
  keyId,
  keySecret,
  readBody,
  createUserSupabase,
  createAdminSupabase,
  verifySignature = verifyRazorpayPaymentSignature,
  fetchPayment = defaultFetchRazorpayPayment,
}: {
  keyId?: string | null;
  keySecret?: string | null;
  readBody: () => Promise<unknown>;
  createUserSupabase: () => SupabaseClient;
  createAdminSupabase: () => SupabaseClient;
  verifySignature?: typeof verifyRazorpayPaymentSignature;
  fetchPayment?: typeof defaultFetchRazorpayPayment;
}): Promise<CreditRazorpayVerifyRouteResult> {
  const body = normalizeBody(await readBody());
  const razorpayOrderId = normalizeString(body.razorpay_order_id);
  const razorpayPaymentId = normalizeString(body.razorpay_payment_id);
  const razorpaySignature = normalizeString(body.razorpay_signature);
  const requestedUserId = normalizeString(body.userId);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !requestedUserId) {
    return { ok: false, status: 400, body: { error: 'Missing required parameters' } };
  }

  const resolvedKeyId = keyId?.trim();
  const secret = keySecret?.trim();
  if (!resolvedKeyId || !secret) {
    logBackendError('razorpay_api_credentials_not_configured');
    return { ok: false, status: 503, body: { error: 'Payment verification is not configured' } };
  }

  if (!verifySignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
    secret,
  })) {
    return { ok: false, status: 400, body: { error: 'Invalid payment signature' } };
  }

  const userSupabase = createUserSupabase();
  const {
    data: { user },
    error: authError,
  } = await getVerifiedAuthUserResult(userSupabase);

  if (authError || !user || user.id !== requestedUserId) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  const adminSupabase = createAdminSupabase();
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...CREDIT_ORDER_VERIFY_RATE_LIMIT,
      key: user.id,
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

    logBackendError('razorpay_verify_rate_limit_check_failed', { error: error });
    return { ok: false, status: 500, body: { error: 'Failed to check payment verification limits.' } };
  }

  const { data: transactionData, error: transactionError } = await userSupabase
    .from('transactions')
    .select('id, user_id, credits, amount, status, razorpay_payment_id, credit_effect_applied')
    .eq('razorpay_order_id', razorpayOrderId)
    .eq('user_id', user.id)
    .single();

  const transaction = (transactionData as CreditTransactionRow | null) ?? null;
  if (transactionError || !transaction) {
    logBackendError('transaction_fetch_error', { error: transactionError });
    return { ok: false, status: 404, body: { error: 'Transaction not found' } };
  }

  if (
    transaction.status === 'success'
    && transaction.razorpay_payment_id !== razorpayPaymentId
  ) {
    logBackendError('razorpay_credit_verify_payment_id_conflict', {
      orderId: razorpayOrderId,
      transactionId: transaction.id,
    });
    return { ok: false, status: 400, body: { error: 'Payment details do not match the order.' } };
  }
  if (transaction.status === 'failed' || transaction.status === 'refunded') {
    return { ok: false, status: 400, body: { error: 'This transaction cannot be fulfilled.' } };
  }

  let payment;
  try {
    payment = await fetchPayment({
      keyId: resolvedKeyId,
      keySecret: secret,
      paymentId: razorpayPaymentId,
    });
  } catch (error) {
    logBackendError('razorpay_credit_payment_lookup_failed', {
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
    expectedAmount: transaction.amount,
    expectedCurrency: 'INR',
    expectedBuyerUserId: user.id,
    buyerNoteKey: 'user_id',
  });
  if (paymentVerification.state === 'pending') {
    return {
      ok: true,
      status: 202,
      body: createPendingPaymentResultBody(),
    };
  }
  if (paymentVerification.state === 'rejected') {
    logBackendError('razorpay_credit_payment_validation_failed', {
      orderId: razorpayOrderId,
      reason: paymentVerification.reason,
    });
    return { ok: false, status: 400, body: { error: 'Payment details do not match the order.' } };
  }

  if (transaction.status === 'success') {
    const referral = await settleCreditPurchaseReferralRewards({
      adminSupabase,
      purchaserUserId: user.id,
      transactionId: transaction.id,
      source: 'razorpay_verify',
    });
    return {
      ok: true,
      body: {
        success: true,
        alreadyProcessed: true,
        ...(referral?.purchaserBonusCredits
          ? { referralBonusCredits: referral.purchaserBonusCredits }
          : {}),
      },
    };
  }

  const { data: rpcSuccess, error: rpcError } = await adminSupabase.rpc('add_credits', {
    p_user_id: user.id,
    p_credits: transaction.credits,
    p_transaction_id: transaction.id,
    p_payment_id: razorpayPaymentId,
  });

  if (rpcError) {
    logBackendError('rpc_add_credits_error', { error: rpcError });
    return { ok: false, status: 500, body: { error: 'Failed to assign credits' } };
  }

  if (!rpcSuccess) {
    const { data: refreshedData, error: refreshedError } = await userSupabase
      .from('transactions')
      .select('id, user_id, credits, amount, status, razorpay_payment_id, credit_effect_applied')
      .eq('razorpay_order_id', razorpayOrderId)
      .eq('user_id', user.id)
      .single();
    const refreshed = (refreshedData as CreditTransactionRow | null) ?? null;

    if (refreshed?.status === 'failed' || refreshed?.status === 'refunded') {
      return { ok: false, status: 400, body: { error: 'This transaction cannot be fulfilled.' } };
    }

    if (
      refreshedError
      || refreshed?.status !== 'success'
      || refreshed.credit_effect_applied !== true
      || refreshed.razorpay_payment_id !== razorpayPaymentId
    ) {
      logBackendError('rpc_add_credits_did_not_settle_the_transaction', { error: refreshedError });
      return { ok: false, status: 500, body: { error: 'Failed to assign credits' } };
    }

    const referral = await settleCreditPurchaseReferralRewards({
      adminSupabase,
      purchaserUserId: user.id,
      transactionId: transaction.id,
      source: 'razorpay_verify',
    });
    return {
      ok: true,
      body: {
        success: true,
        alreadyProcessed: true,
        ...(referral?.purchaserBonusCredits
          ? { referralBonusCredits: referral.purchaserBonusCredits }
          : {}),
      },
    };
  }

  const referral = await settleCreditPurchaseReferralRewards({
    adminSupabase,
    purchaserUserId: user.id,
    transactionId: transaction.id,
    source: 'razorpay_verify',
  });

  return {
    ok: true,
    body: {
      success: true,
      ...(referral?.purchaserBonusCredits
        ? { referralBonusCredits: referral.purchaserBonusCredits }
        : {}),
    },
  };
}

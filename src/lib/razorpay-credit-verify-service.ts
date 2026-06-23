import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CREDIT_ORDER_VERIFY_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { verifyRazorpayPaymentSignature } from '@/lib/razorpay-signature';

type CreditVerifyBody = {
  razorpay_order_id?: unknown;
  razorpay_payment_id?: unknown;
  razorpay_signature?: unknown;
  userId?: unknown;
};

type CreditTransactionRow = {
  id: string;
  credits: number;
  status: 'created' | 'success' | 'failed' | string;
};

export type CreditRazorpayVerifyRouteResult =
  | {
      ok: true;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: 400 | 401 | 404 | 429 | 500 | 503;
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
  keySecret,
  readBody,
  createUserSupabase,
  createAdminSupabase,
  verifySignature = verifyRazorpayPaymentSignature,
}: {
  keySecret?: string | null;
  readBody: () => Promise<unknown>;
  createUserSupabase: () => SupabaseClient;
  createAdminSupabase: () => SupabaseClient;
  verifySignature?: typeof verifyRazorpayPaymentSignature;
}): Promise<CreditRazorpayVerifyRouteResult> {
  const body = normalizeBody(await readBody());
  const razorpayOrderId = normalizeString(body.razorpay_order_id);
  const razorpayPaymentId = normalizeString(body.razorpay_payment_id);
  const razorpaySignature = normalizeString(body.razorpay_signature);
  const requestedUserId = normalizeString(body.userId);

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !requestedUserId) {
    return { ok: false, status: 400, body: { error: 'Missing required parameters' } };
  }

  const secret = keySecret?.trim();
  if (!secret) {
    console.error('RAZORPAY_KEY_SECRET not configured');
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
  } = await userSupabase.auth.getUser();

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

    console.error('Razorpay verify rate limit check failed:', error);
    return { ok: false, status: 500, body: { error: 'Failed to check payment verification limits.' } };
  }

  const { data: transactionData, error: transactionError } = await userSupabase
    .from('transactions')
    .select('id, credits, status')
    .eq('razorpay_order_id', razorpayOrderId)
    .eq('user_id', user.id)
    .single();

  const transaction = (transactionData as CreditTransactionRow | null) ?? null;
  if (transactionError || !transaction) {
    console.error('Transaction fetch error:', transactionError);
    return { ok: false, status: 404, body: { error: 'Transaction not found' } };
  }

  if (transaction.status === 'success') {
    return { ok: true, body: { success: true, alreadyProcessed: true } };
  }

  const { data: rpcSuccess, error: rpcError } = await adminSupabase.rpc('add_credits', {
    p_user_id: user.id,
    p_credits: transaction.credits,
    p_transaction_id: transaction.id,
    p_payment_id: razorpayPaymentId,
  });

  if (rpcError || !rpcSuccess) {
    console.error('RPC add_credits error:', rpcError);
    return { ok: false, status: 500, body: { error: 'Failed to assign credits' } };
  }

  return { ok: true, body: { success: true } };
}

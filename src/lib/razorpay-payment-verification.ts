import 'server-only';

import type { RazorpayPaymentResponse } from '@/lib/razorpay-orders';

export type RazorpayPaymentVerification =
  | { state: 'captured' }
  | { state: 'pending'; providerStatus: 'created' | 'authorized' }
  | {
      state: 'rejected';
      reason:
        | 'payment_id_mismatch'
        | 'order_id_mismatch'
        | 'amount_mismatch'
        | 'currency_mismatch'
        | 'buyer_mismatch'
        | 'payment_already_reversed'
        | 'payment_not_captured';
    };

export function verifyRazorpayPaymentAgainstOrder({
  buyerNoteKey,
  expectedAmount,
  expectedBuyerUserId,
  expectedCurrency,
  expectedOrderId,
  expectedPaymentId,
  payment,
}: {
  buyerNoteKey: 'user_id' | 'buyer_user_id';
  expectedAmount: number;
  expectedBuyerUserId: string;
  expectedCurrency: string;
  expectedOrderId: string;
  expectedPaymentId: string;
  payment: RazorpayPaymentResponse;
}): RazorpayPaymentVerification {
  if (payment.id !== expectedPaymentId) {
    return { state: 'rejected', reason: 'payment_id_mismatch' };
  }
  if (payment.orderId !== expectedOrderId) {
    return { state: 'rejected', reason: 'order_id_mismatch' };
  }
  if (payment.amount !== expectedAmount) {
    return { state: 'rejected', reason: 'amount_mismatch' };
  }
  if (payment.currency !== expectedCurrency.trim().toUpperCase()) {
    return { state: 'rejected', reason: 'currency_mismatch' };
  }
  // The authenticated/local order row is the canonical buyer binding.
  // Razorpay keeps Order notes and Payment notes as separate entity fields, so
  // an order note is not assumed to appear on the fetched payment. If a
  // payment-level buyer note is present, it must agree with that binding.
  const providerBuyerUserId = payment.notes[buyerNoteKey];
  if (
    providerBuyerUserId !== undefined
    && providerBuyerUserId !== expectedBuyerUserId
  ) {
    return { state: 'rejected', reason: 'buyer_mismatch' };
  }
  if (payment.amountRefunded > 0 || payment.status === 'refunded') {
    return { state: 'rejected', reason: 'payment_already_reversed' };
  }
  if (
    (payment.status === 'created' || payment.status === 'authorized')
    && payment.captured === false
  ) {
    return { state: 'pending', providerStatus: payment.status };
  }
  if (payment.status === 'captured' && payment.captured === true) {
    return { state: 'captured' };
  }

  return { state: 'rejected', reason: 'payment_not_captured' };
}

export function createPendingPaymentResultBody() {
  return {
    success: false,
    status: 'pending',
    pending: true,
    code: 'PAYMENT_PENDING',
    retryAfterSeconds: 2,
    message: 'Payment is authorized and waiting to be captured.',
  } as const;
}

import { describe, expect, it } from 'vitest';

import { verifyRazorpayPaymentAgainstOrder } from '@/lib/razorpay-payment-verification';
import type { RazorpayPaymentResponse } from '@/lib/razorpay-orders';

function payment(overrides: Partial<RazorpayPaymentResponse> = {}): RazorpayPaymentResponse {
  return {
    id: 'pay_123',
    orderId: 'order_123',
    amount: 10_000,
    amountRefunded: 0,
    currency: 'INR',
    status: 'captured',
    captured: true,
    notes: { buyer_user_id: 'buyer-1' },
    ...overrides,
  };
}

function verify(value: RazorpayPaymentResponse) {
  return verifyRazorpayPaymentAgainstOrder({
    payment: value,
    expectedPaymentId: 'pay_123',
    expectedOrderId: 'order_123',
    expectedAmount: 10_000,
    expectedCurrency: 'INR',
    expectedBuyerUserId: 'buyer-1',
    buyerNoteKey: 'buyer_user_id',
  });
}

describe('verifyRazorpayPaymentAgainstOrder', () => {
  it('accepts only a fully matching captured payment', () => {
    expect(verify(payment())).toEqual({ state: 'captured' });
  });

  it('uses authenticated order ownership when payment-level notes are absent', () => {
    expect(verify(payment({ notes: {} }))).toEqual({ state: 'captured' });
  });

  it('returns pending for a matching authorized payment', () => {
    expect(verify(payment({ status: 'authorized', captured: false }))).toEqual({
      state: 'pending',
      providerStatus: 'authorized',
    });
  });

  it.each([
    ['payment id', { id: 'pay_other' }, 'payment_id_mismatch'],
    ['order id', { orderId: 'order_other' }, 'order_id_mismatch'],
    ['amount', { amount: 9_999 }, 'amount_mismatch'],
    ['currency', { currency: 'USD' }, 'currency_mismatch'],
    ['buyer', { notes: { buyer_user_id: 'other-buyer' } }, 'buyer_mismatch'],
    ['refund', { amountRefunded: 1 }, 'payment_already_reversed'],
  ] as const)('rejects a %s mismatch', (_label, overrides, reason) => {
    expect(verify(payment(overrides))).toEqual({ state: 'rejected', reason });
  });
});

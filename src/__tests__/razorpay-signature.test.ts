import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createRazorpaySignature,
  verifyRazorpayPaymentSignature,
  verifyRazorpaySignature,
} from '@/lib/razorpay-signature';

describe('Razorpay signature helpers', () => {
  it('creates and verifies timing-safe Razorpay signatures', () => {
    const payload = 'order_123|pay_123';
    const signature = createHmac('sha256', 'secret').update(payload).digest('hex');

    expect(createRazorpaySignature(payload, 'secret')).toBe(signature);
    expect(verifyRazorpaySignature({ payload, signature, secret: 'secret' })).toBe(true);
    expect(verifyRazorpaySignature({ payload, signature: 'bad-signature', secret: 'secret' })).toBe(false);
    expect(verifyRazorpaySignature({ payload, signature, secret: '' })).toBe(false);
  });

  it('verifies checkout payment signatures from order and payment ids', () => {
    const signature = createRazorpaySignature('order_123|pay_123', 'secret');

    expect(verifyRazorpayPaymentSignature({
      orderId: 'order_123',
      paymentId: 'pay_123',
      signature,
      secret: 'secret',
    })).toBe(true);
    expect(verifyRazorpayPaymentSignature({
      orderId: 'order_123',
      paymentId: 'pay_other',
      signature,
      secret: 'secret',
    })).toBe(false);
  });
});

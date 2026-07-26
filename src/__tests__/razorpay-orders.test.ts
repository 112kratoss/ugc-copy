import { describe, expect, it, vi } from 'vitest';

import {
  fetchRazorpayOrderByReceipt,
  fetchRazorpayPayment,
  RazorpayPaymentError,
} from '@/lib/razorpay-orders';

function paymentBody() {
  return {
    id: 'pay_123',
    order_id: 'order_123',
    amount: 10_000,
    amount_refunded: 0,
    currency: 'inr',
    status: 'captured',
    captured: true,
    notes: { buyer_user_id: 'buyer-1' },
  };
}

describe('fetchRazorpayPayment', () => {
  it('performs a bounded authenticated payment lookup and parses the result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(paymentBody()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fetchRazorpayPayment({
      keyId: 'rzp_key',
      keySecret: 'rzp_secret',
      paymentId: 'pay_123',
      fetcher,
    })).resolves.toEqual({
      id: 'pay_123',
      orderId: 'order_123',
      amount: 10_000,
      amountRefunded: 0,
      currency: 'INR',
      status: 'captured',
      captured: true,
      notes: { buyer_user_id: 'buyer-1' },
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.razorpay.com/v1/payments/pay_123',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('rzp_key:rzp_secret').toString('base64')}`,
        }),
      }),
    );
  });

  it('rejects invalid identifiers without making a provider request', async () => {
    const fetcher = vi.fn();

    await expect(fetchRazorpayPayment({
      keyId: 'rzp_key',
      keySecret: 'rzp_secret',
      paymentId: '../orders',
      fetcher,
    })).rejects.toMatchObject({
      name: 'RazorpayPaymentError',
      status: 400,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized provider responses', async () => {
    const fetcher = vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(65 * 1024) },
    }));

    await expect(fetchRazorpayPayment({
      keyId: 'rzp_key',
      keySecret: 'rzp_secret',
      paymentId: 'pay_123',
      fetcher,
    })).rejects.toBeInstanceOf(RazorpayPaymentError);
  });

  it('fails closed when the provider omits refund state', async () => {
    const body = paymentBody();
    const { amount_refunded: _omitted, ...withoutRefundState } = body;
    void _omitted;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(withoutRefundState), {
      status: 200,
    }));

    await expect(fetchRazorpayPayment({
      keyId: 'rzp_key',
      keySecret: 'rzp_secret',
      paymentId: 'pay_123',
      fetcher,
    })).rejects.toBeInstanceOf(RazorpayPaymentError);
  });

  it('recovers exactly one provider order by its stable receipt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: 'order_123',
        amount: 10_000,
        currency: 'INR',
        receipt: 'mb_1234567890123456',
      }],
    }), { status: 200 }));

    await expect(fetchRazorpayOrderByReceipt({
      keyId: 'rzp_key',
      keySecret: 'rzp_secret',
      receipt: 'mb_1234567890123456',
      fetcher,
    })).resolves.toEqual({
      id: 'order_123',
      amount: 10_000,
      currency: 'INR',
      receipt: 'mb_1234567890123456',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.razorpay.com/v1/orders?receipt=mb_1234567890123456&count=2',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

import { verifyRazorpayCheckoutUntilSettled } from '@/lib/razorpay-checkout-client';

describe('verifyRazorpayCheckoutUntilSettled', () => {
  it('polls a 202 payment until capture settles', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        status: 'pending',
        code: 'PAYMENT_PENDING',
        retryAfterSeconds: 2,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    await expect(verifyRazorpayCheckoutUntilSettled({
      url: '/api/payment/verify',
      token: 'token',
      body: { payment: 'pay_123' },
      fetcher,
      sleep,
    })).resolves.toEqual({
      state: 'settled',
      body: { success: true },
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns a non-error pending result after the bounded polling window', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      status: 'pending',
      code: 'PAYMENT_PENDING',
      retryAfterSeconds: 1,
    }), { status: 202 }));

    await expect(verifyRazorpayCheckoutUntilSettled({
      url: '/api/payment/verify',
      token: 'token',
      body: {},
      fetcher,
      maxAttempts: 2,
      sleep: vi.fn(async () => undefined),
    })).resolves.toMatchObject({
      state: 'pending',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws the stable server error for rejected payments', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'Payment details do not match the order.',
    }), { status: 400 }));

    await expect(verifyRazorpayCheckoutUntilSettled({
      url: '/api/payment/verify',
      token: 'token',
      body: {},
      fetcher,
      sleep: vi.fn(async () => undefined),
    })).rejects.toThrow('Payment details do not match the order.');
  });
});

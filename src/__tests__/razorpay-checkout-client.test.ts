import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pollCreditBalanceAfterPayment,
  verifyRazorpayCheckoutUntilSettled,
} from '@/lib/razorpay-checkout-client';

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

  it('reads the bearer again before every attempt when given a reader', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        status: 'pending',
        code: 'PAYMENT_PENDING',
        retryAfterSeconds: 1,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const tokens = ['token-at-return', 'token-after-refresh'];
    const readToken = vi.fn(async () => tokens.shift() ?? 'unexpected');

    await expect(verifyRazorpayCheckoutUntilSettled({
      url: '/api/payment/verify',
      token: readToken,
      body: {},
      fetcher,
      sleep: vi.fn(async () => undefined),
    })).resolves.toMatchObject({ state: 'settled' });

    expect(readToken).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit).headers)).toEqual([
      expect.objectContaining({ Authorization: 'Bearer token-at-return' }),
      expect.objectContaining({ Authorization: 'Bearer token-after-refresh' }),
    ]);
  });

  it('sends nothing when the reader has no session to give', async () => {
    const fetcher = vi.fn();

    await expect(verifyRazorpayCheckoutUntilSettled({
      url: '/api/payment/verify',
      token: async () => {
        throw new Error('signed out');
      },
      body: {},
      fetcher,
    })).rejects.toThrow('signed out');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('pollCreditBalanceAfterPayment', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function countBalanceReads() {
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener('credits_updated', listener);
    return { events, stop: () => window.removeEventListener('credits_updated', listener) };
  }

  it('asks for the balance now and every five seconds for one minute', () => {
    vi.useFakeTimers();
    const reads = countBalanceReads();

    try {
      pollCreditBalanceAfterPayment();
      expect(reads.events).toHaveLength(1);
      vi.advanceTimersByTime(5_000);
      expect(reads.events).toHaveLength(2);
      vi.advanceTimersByTime(55_000);
      expect(reads.events).toHaveLength(13);
      vi.advanceTimersByTime(60_000);
      expect(reads.events).toHaveLength(13);
    } finally {
      reads.stop();
    }
  });

  it('stops early when asked', () => {
    vi.useFakeTimers();
    const reads = countBalanceReads();

    try {
      const stop = pollCreditBalanceAfterPayment();
      vi.advanceTimersByTime(10_000);
      stop();
      vi.advanceTimersByTime(60_000);
      expect(reads.events).toHaveLength(3);
    } finally {
      reads.stop();
    }
  });
});

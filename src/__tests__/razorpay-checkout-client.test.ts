import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pollBundleUntilUnlocked,
  pollCreditBalanceAfterPayment,
  readCheckoutAccessToken,
  verifyRazorpayCheckoutUntilSettled,
} from '@/lib/razorpay-checkout-client';

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

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

describe('readCheckoutAccessToken', () => {
  it("reads the browser session's token as it is now, every time it is asked", async () => {
    mockGetSession
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-at-return' } } })
      .mockResolvedValueOnce({ data: { session: { access_token: 'token-after-refresh' } } });

    await expect(readCheckoutAccessToken()).resolves.toBe('token-at-return');
    await expect(readCheckoutAccessToken()).resolves.toBe('token-after-refresh');
  });

  it('refuses when the session has ended, so nothing is sent with a dead token', async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });

    await expect(readCheckoutAccessToken()).rejects.toThrow('The session ended while the payment was being made.');
  });
});

describe('pollBundleUntilUnlocked', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const locked = () => new Response(JSON.stringify({
    bundle: { viewerCanAccess: false, viewerIsOwner: false, resources: null },
  }));
  const unlocked = () => new Response(JSON.stringify({
    bundle: { viewerCanAccess: true, viewerIsOwner: false, resources: { promptText: 'paid prompt' } },
  }));

  it('reads the recipe now and every five seconds with a fresh token, and hands over the first unlocked read', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(locked())
      .mockResolvedValueOnce(locked())
      .mockResolvedValueOnce(unlocked());
    let tokenNumber = 0;
    const token = vi.fn(async () => `token-${++tokenNumber}`);
    const onUnlocked = vi.fn();

    pollBundleUntilUnlocked({ postId: 'post-1', token, onUnlocked, fetcher });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onUnlocked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(onUnlocked).toHaveBeenCalledWith({
      viewerCanAccess: true,
      viewerIsOwner: false,
      resources: { promptText: 'paid prompt' },
    });
    expect(fetcher.mock.calls.map(([url, init]) => [url, (init as RequestInit).headers])).toEqual([
      ['/api/posts/post-1/resource-bundle', { Authorization: 'Bearer token-1' }],
      ['/api/posts/post-1/resource-bundle', { Authorization: 'Bearer token-2' }],
      ['/api/posts/post-1/resource-bundle', { Authorization: 'Bearer token-3' }],
    ]);

    // Handed over once; nothing reads after that.
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops after a minute of reads, then reads once more when the tab is next focused', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => locked());
    const onUnlocked = vi.fn();

    pollBundleUntilUnlocked({ postId: 'post-1', token: async () => 'token', onUnlocked, fetcher });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(13);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(13);

    fetcher.mockImplementationOnce(async () => unlocked());
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(14);
    expect(onUnlocked).toHaveBeenCalledTimes(1);

    // Once: a later return to the tab reads nothing more.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(14);
  });

  it('keeps reading through a failed read, a server error and a session it could not read', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(unlocked());
    const token = vi.fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2')
      .mockRejectedValueOnce(new Error('The session ended while the payment was being made.'))
      .mockResolvedValueOnce('token-4');
    const onUnlocked = vi.fn();

    pollBundleUntilUnlocked({ postId: 'post-1', token, onUnlocked, fetcher });
    await vi.advanceTimersByTimeAsync(15_000);

    // The third turn had no token, so it sent nothing; the fourth found the recipe open.
    expect(token).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it('reads nothing more once stopped, neither on a timer nor on focus', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => locked());
    const onUnlocked = vi.fn();

    const stop = pollBundleUntilUnlocked({ postId: 'post-1', token: async () => 'token', onUnlocked, fetcher });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('drops an answer that arrives after it was stopped', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      answer = resolve;
    }));
    const onUnlocked = vi.fn();

    const stop = pollBundleUntilUnlocked({ postId: 'post-1', token: async () => 'token', onUnlocked, fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    stop();
    answer(unlocked());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUnlocked).not.toHaveBeenCalled();
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

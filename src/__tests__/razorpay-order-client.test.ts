import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXTERNAL_API_REQUEST_TIMEOUT_MS } from '@/lib/provider-fetch';

describe('Razorpay order client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates orders through the abortable provider fetch wrapper with Basic Auth', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: 'order_123',
      amount: 41500,
      currency: 'INR',
      receipt: 'receipt-1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { createRazorpayOrder } = await import('@/lib/razorpay-orders');
    const order = await createRazorpayOrder({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      amount: 41500,
      currency: 'INR',
      receipt: 'receipt-1',
      notes: { source: 'test' },
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(order).toMatchObject({ id: 'order_123' });
    expect(fetcher).toHaveBeenCalledWith('https://api.razorpay.com/v1/orders', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: `Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        amount: 41500,
        currency: 'INR',
        receipt: 'receipt-1',
        notes: { source: 'test' },
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(timeoutSpy).toHaveBeenCalledWith(EXTERNAL_API_REQUEST_TIMEOUT_MS);
  });

  it('rejects invalid Razorpay order responses before callers persist local orders', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { description: 'bad request' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { createRazorpayOrder } = await import('@/lib/razorpay-orders');

    await expect(createRazorpayOrder({
      keyId: 'rzp_test_key',
      keySecret: 'secret',
      amount: 41500,
      currency: 'INR',
      receipt: 'receipt-1',
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: 'RazorpayOrderError',
      message: 'Unable to create Razorpay order.',
      status: 502,
      providerStatus: 400,
    });
  });

  it('rejects test-mode credentials before contacting Razorpay in production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const fetcher = vi.fn();
    const { createRazorpayOrder } = await import('@/lib/razorpay-orders');

    await expect(createRazorpayOrder({
      keyId: 'rzp_test_accidental',
      keySecret: 'secret',
      amount: 41500,
      currency: 'INR',
      receipt: 'receipt-1',
      fetcher: fetcher as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: 'RazorpayOrderError',
      message: 'Razorpay live credentials are required in production.',
      status: 500,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

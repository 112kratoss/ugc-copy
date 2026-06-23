import { describe, expect, it, vi } from 'vitest';

import { postRazorpayWebhookRouteResponse } from '@/lib/razorpay-webhook-route-adapter-service';

function createRequest({
  body = '{"event":"payment.captured"}',
  headers = {},
}: {
  body?: string;
  headers?: Record<string, string>;
} = {}) {
  return new Request('http://localhost/api/razorpay/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });
}

describe('Razorpay webhook route adapter service', () => {
  it('returns a private configuration error before reading the body when the secret is missing', async () => {
    const processRazorpayWebhookForRoute = vi.fn();
    const createServiceClient = vi.fn();
    const verifyRazorpaySignature = vi.fn();
    const request = createRequest({
      headers: { 'x-request-id': 'razorpay-adapter-missing-secret-1' },
    });
    const textSpy = vi.spyOn(request, 'text');

    const response = await postRazorpayWebhookRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        getWebhookSecret: () => undefined,
        logError: vi.fn(),
        processRazorpayWebhookForRoute,
        verifyRazorpaySignature,
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('razorpay-adapter-missing-secret-1');
    await expect(response.text()).resolves.toBe('Webhook secret not configured');
    expect(textSpy).not.toHaveBeenCalled();
    expect(verifyRazorpaySignature).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(processRazorpayWebhookForRoute).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads before reading the body or creating privileged clients', async () => {
    const request = createRequest({
      headers: {
        'content-length': '262145',
        'x-request-id': 'razorpay-adapter-oversized-1',
      },
    });
    const textSpy = vi.spyOn(request, 'text');
    const createServiceClient = vi.fn();

    const response = await postRazorpayWebhookRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        getWebhookSecret: () => 'webhook-secret',
        isWebhookPayloadTooLarge: () => true,
        verifyRazorpaySignature: vi.fn(),
      },
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('razorpay-adapter-oversized-1');
    await expect(response.text()).resolves.toBe('Webhook payload too large');
    expect(textSpy).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('rejects invalid signatures before creating a privileged Supabase client', async () => {
    const createServiceClient = vi.fn();
    const processRazorpayWebhookForRoute = vi.fn();
    const verifyRazorpaySignature = vi.fn(() => false);

    const response = await postRazorpayWebhookRouteResponse({
      request: createRequest({
        body: '{"event":"payment.captured","payload":{}}',
        headers: {
          'x-razorpay-signature': 'bad-signature',
          'x-request-id': 'razorpay-adapter-invalid-signature-1',
        },
      }),
      dependencies: {
        createServiceClient,
        getWebhookSecret: () => 'webhook-secret',
        logError: vi.fn(),
        processRazorpayWebhookForRoute,
        verifyRazorpaySignature,
      },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('razorpay-adapter-invalid-signature-1');
    await expect(response.text()).resolves.toBe('Invalid signature');
    expect(verifyRazorpaySignature).toHaveBeenCalledWith({
      payload: '{"event":"payment.captured","payload":{}}',
      signature: 'bad-signature',
      secret: 'webhook-secret',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(processRazorpayWebhookForRoute).not.toHaveBeenCalled();
  });

  it('delegates valid signed payloads through the webhook service with private headers', async () => {
    const adminClient = { kind: 'supabase-admin' };
    const createServiceClient = vi.fn(() => adminClient as never);
    const processRazorpayWebhookForRoute = vi.fn(async () => ({
      status: 200 as const,
      body: 'OK',
    }));
    const body = '{"event":"payment.captured","payload":{}}';

    const response = await postRazorpayWebhookRouteResponse({
      request: createRequest({
        body,
        headers: {
          'x-razorpay-signature': 'valid-signature',
          'x-request-id': 'razorpay-adapter-success-1',
        },
      }),
      dependencies: {
        createServiceClient,
        getWebhookSecret: () => 'webhook-secret',
        processRazorpayWebhookForRoute,
        verifyRazorpaySignature: vi.fn(() => true),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('razorpay-adapter-success-1');
    await expect(response.text()).resolves.toBe('OK');
    expect(processRazorpayWebhookForRoute).toHaveBeenCalledWith({
      createAdminSupabase: createServiceClient,
      rawBody: body,
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });
});

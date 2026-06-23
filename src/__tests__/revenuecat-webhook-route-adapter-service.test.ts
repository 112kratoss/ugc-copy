import { describe, expect, it, vi } from 'vitest';

import { postRevenueCatWebhookRouteResponse } from '@/lib/revenuecat-webhook-route-adapter-service';

function webhookRequest(
  body: unknown,
  authorization = 'Bearer revenuecat-webhook-secret',
  headers: Record<string, string> = {},
) {
  return new Request('http://localhost/api/mobile/commerce/revenuecat-webhook', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const refundPayload = {
  api_version: '1.0',
  event: {
    id: 'event-refund-1',
    type: 'CANCELLATION',
    product_id: 'magicbooklet.credits.creator',
    transaction_id: 'GPA.1234-5678-9012-34567',
    original_transaction_id: 'GPA.1234-5678-9012-34567',
    app_user_id: '6a0bf06c-2829-45c7-93c1-06f5fe4bc15d',
    store: 'PLAY_STORE',
    cancel_reason: 'CUSTOMER_SUPPORT',
    event_timestamp_ms: 1_766_000_000_000,
    price: -19.99,
  },
};

describe('RevenueCat webhook route adapter service', () => {
  it('fails closed before privileged work when the webhook secret is not configured', async () => {
    const rpc = vi.fn();
    const createServiceClient = vi.fn(() => ({ rpc }));

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest(refundPayload, 'Bearer revenuecat-webhook-secret', {
        'x-request-id': 'revenuecat-webhook-config-1',
      }),
      dependencies: {
        createServiceClient,
        getExpectedAuthorization: () => '',
        logError: vi.fn(),
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('revenuecat-webhook-config-1');
    await expect(response.json()).resolves.toEqual({ error: 'Webhook is not configured.' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads before JSON parsing or privileged work', async () => {
    const rpc = vi.fn();
    const createServiceClient = vi.fn(() => ({ rpc }));

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest(refundPayload, 'Bearer revenuecat-webhook-secret', {
        'content-length': '262145',
        'x-request-id': 'revenuecat-webhook-size-1',
      }),
      dependencies: {
        createServiceClient,
        getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
      },
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('revenuecat-webhook-size-1');
    await expect(response.json()).resolves.toEqual({ error: 'Webhook payload is too large.' });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reconciles valid credit refund events through the Supabase RPC', async () => {
    const rpc = vi.fn(async () => ({ data: 'refunded', error: null }));
    const createServiceClient = vi.fn(() => ({ rpc }));

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest(refundPayload, 'Bearer revenuecat-webhook-secret', {
        'x-request-id': 'revenuecat-webhook-success-1',
      }),
      dependencies: {
        createServiceClient,
        getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('revenuecat-webhook-success-1');
    await expect(response.json()).resolves.toEqual({ received: true, result: 'refunded' });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('reconcile_mobile_credit_refund', {
      p_action: 'refund',
      p_event_id: 'event-refund-1',
      p_event_timestamp_ms: 1_766_000_000_000,
      p_external_order_id: 'mobile_play_store_GPA.1234-5678-9012-34567',
      p_product_id: 'magicbooklet.credits.creator',
      p_user_id: '6a0bf06c-2829-45c7-93c1-06f5fe4bc15d',
    });
  });
});

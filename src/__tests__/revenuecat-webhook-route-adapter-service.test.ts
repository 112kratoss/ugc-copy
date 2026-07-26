import type { SupabaseClient } from '@supabase/supabase-js';
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
    const createServiceClient = vi.fn(
      () => ({ rpc }) as unknown as SupabaseClient,
    );

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
    const createServiceClient = vi.fn(
      () => ({ rpc }) as unknown as SupabaseClient,
    );

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

  it('uses the bounded body reader even when Content-Length is absent', async () => {
    const rpc = vi.fn();
    const createServiceClient = vi.fn(
      () => ({ rpc }) as unknown as SupabaseClient,
    );
    const readBoundedWebhookBody = vi.fn(async () => ({
      ok: false as const,
      reason: 'too_large' as const,
    }));

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest(refundPayload),
      dependencies: {
        createServiceClient,
        getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
        readBoundedWebhookBody,
      },
    });

    expect(response.status).toBe(413);
    expect(readBoundedWebhookBody).toHaveBeenCalledTimes(1);
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reconciles valid credit refund events through the Supabase RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: { status: 'refunded', rewards: [] },
      error: null,
    }));
    const createServiceClient = vi.fn(
      () => ({ rpc }) as unknown as SupabaseClient,
    );

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
    expect(rpc).toHaveBeenCalledWith('reconcile_mobile_purchase_adjustment', {
      p_action: 'refund',
      p_event_id: 'event-refund-1',
      p_event_timestamp_ms: 1_766_000_000_000,
      p_external_order_id: 'mobile_play_store_GPA.1234-5678-9012-34567',
      p_product_id: 'magicbooklet.credits.creator',
      p_user_id: '6a0bf06c-2829-45c7-93c1-06f5fe4bc15d',
    });
  });

  it('returns a retryable error until a backfilled order is bound to its real product', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        status: 'legacy_product_unbound',
        entitlement_type: 'marketplace_unlock',
        amount_subunits: 900,
        currency: 'USD',
        rewards: [],
      },
      error: null,
    }));
    const logError = vi.fn();
    const recordPaymentWebhookProcessingFailure = vi.fn(async () => {});

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest({
        ...refundPayload,
        event: {
          ...refundPayload.event,
          product_id: 'magicbooklet.marketplace.usd900',
        },
      }),
      dependencies: {
        createServiceClient: () => ({ rpc }) as never,
        getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
        logError,
        recordPaymentWebhookProcessingFailure,
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Refund reconciliation failed.' });
    expect(logError).toHaveBeenCalledWith(
      'RevenueCat purchase adjustment reconciliation failed:',
      expect.objectContaining({
        message: 'Backfilled mobile transaction mobile_play_store_GPA.1234-5678-9012-34567 requires catalog binding to magicbooklet.marketplace.usd900',
      }),
    );
    expect(recordPaymentWebhookProcessingFailure).toHaveBeenCalledWith(
      {
        serviceName: 'revenuecat-webhook-processing',
        failureCode: 'refund_reconciliation_failed',
        status: 503,
      },
      expect.objectContaining({ rpc }),
    );
  });

  it('asks RevenueCat to retry refunds that arrive before the purchase has synced', async () => {
    const rpc = vi.fn(async () => ({
      data: { status: 'not_found', rewards: [] },
      error: null,
    }));
    const logError = vi.fn();
    const recordPaymentWebhookProcessingFailure = vi.fn(async () => {});

    const response = await postRevenueCatWebhookRouteResponse({
      request: webhookRequest(refundPayload),
      dependencies: {
        createServiceClient: () => ({ rpc }) as never,
        getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
        logError,
        recordPaymentWebhookProcessingFailure,
      },
    });

    // A 200 here would stop RevenueCat's redelivery and permanently drop the
    // refund for a purchase whose sync has not landed yet.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Purchase is not synced yet.' });
    expect(recordPaymentWebhookProcessingFailure).toHaveBeenCalledWith(
      {
        serviceName: 'revenuecat-webhook-processing',
        failureCode: 'refund_purchase_not_synced',
        status: 503,
      },
      expect.objectContaining({ rpc }),
    );
  });

  it('acknowledges permanent reconciliation outcomes without asking for a retry', async () => {
    const recordPaymentWebhookProcessingFailure = vi.fn(async () => {});

    for (const status of ['duplicate_event', 'stale_event', 'identity_mismatch', 'refunded']) {
      const rpc = vi.fn(async () => ({
        data: { status, rewards: [] },
        error: null,
      }));

      const response = await postRevenueCatWebhookRouteResponse({
        request: webhookRequest(refundPayload),
        dependencies: {
          createServiceClient: () => ({ rpc }) as never,
          getExpectedAuthorization: () => 'Bearer revenuecat-webhook-secret',
          recordPaymentWebhookProcessingFailure,
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true, result: status });
    }

    expect(recordPaymentWebhookProcessingFailure).not.toHaveBeenCalled();
  });
});

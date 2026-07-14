import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ rpc: rpcMock }),
}));

function webhookRequest(
  event: Record<string, unknown>,
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
    body: JSON.stringify({ api_version: '1.0', event }),
  });
}

function expectPrivateNoStoreTraceHeaders(response: Response, requestId: string) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('x-request-id')).toBe(requestId);
}

const refundEvent = {
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
};

describe('/api/mobile/commerce/revenuecat-webhook', () => {
  beforeEach(() => {
    vi.resetModules();
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { status: 'refunded', rewards: [] }, error: null });
    process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN = 'Bearer revenuecat-webhook-secret';
  });

  it('rejects requests without the configured authorization header', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest(refundEvent, '', {
      'x-request-id': 'revenuecat-webhook-auth-1',
    }));

    expect(response.status).toBe(401);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-auth-1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('fails closed when webhook authorization is not configured', async () => {
    delete process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN;
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest(refundEvent, 'Bearer revenuecat-webhook-secret', {
      'x-request-id': 'revenuecat-webhook-config-1',
    }));

    expect(response.status).toBe(503);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-config-1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('ignores events that cannot change a credit top-up', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest({ ...refundEvent, type: 'TEST' }, 'Bearer revenuecat-webhook-secret', {
      'x-request-id': 'revenuecat-webhook-ignored-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-ignored-1');
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads before refund reconciliation work', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest(refundEvent, 'Bearer revenuecat-webhook-secret', {
      'content-length': '262145',
      'x-request-id': 'revenuecat-webhook-oversized-1',
    }));

    expect(response.status).toBe(413);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-oversized-1');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('passes non-credit product cancellations to the global entitlement ledger', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest({ ...refundEvent, product_id: 'monthly.subscription' }, 'Bearer revenuecat-webhook-secret', {
      'x-request-id': 'revenuecat-webhook-noncatalog-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-noncatalog-1');
    expect(rpcMock).toHaveBeenCalledWith('reconcile_mobile_purchase_adjustment', expect.objectContaining({
      p_product_id: 'monthly.subscription',
    }));
  });

  it('reconciles a refunded Play Store credit purchase', async () => {
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest(refundEvent, 'Bearer revenuecat-webhook-secret', {
      'x-request-id': 'revenuecat-webhook-success-1',
    }));

    expect(response.status).toBe(200);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-success-1');
    expect(await response.json()).toEqual({ received: true, result: 'refunded' });
    expect(rpcMock).toHaveBeenCalledWith('reconcile_mobile_purchase_adjustment', {
      p_action: 'refund',
      p_event_id: 'event-refund-1',
      p_event_timestamp_ms: 1_766_000_000_000,
      p_external_order_id: 'mobile_play_store_GPA.1234-5678-9012-34567',
      p_product_id: 'magicbooklet.credits.creator',
      p_user_id: '6a0bf06c-2829-45c7-93c1-06f5fe4bc15d',
    });
  });

  it('restores credits when RevenueCat reverses a refund', async () => {
    rpcMock.mockResolvedValue({ data: { status: 'restored', rewards: [] }, error: null });
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest({
      ...refundEvent,
      id: 'event-refund-reversed-1',
      type: 'REFUND_REVERSED',
      store: 'APP_STORE',
      transaction_id: '2000000123456789',
      original_transaction_id: '2000000123456789',
      event_timestamp_ms: 1_766_000_100_000,
      price: 19.99,
    }));

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('reconcile_mobile_purchase_adjustment', expect.objectContaining({
      p_action: 'restore',
      p_external_order_id: 'mobile_app_store_2000000123456789',
    }));
  });

  it('treats duplicate and stale deliveries as successful', async () => {
    rpcMock.mockResolvedValue({ data: { status: 'already_refunded', rewards: [] }, error: null });
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const duplicateResponse = await POST(webhookRequest(refundEvent));

    rpcMock.mockResolvedValue({ data: { status: 'stale_event', rewards: [] }, error: null });
    const staleResponse = await POST(webhookRequest({ ...refundEvent, id: 'older-event' }));

    expect(duplicateResponse.status).toBe(200);
    expect(staleResponse.status).toBe(200);
  });

  it('returns a retryable error when database reconciliation fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });
    const { POST } = await import('@/app/api/mobile/commerce/revenuecat-webhook/route');
    const response = await POST(webhookRequest(refundEvent, 'Bearer revenuecat-webhook-secret', {
      'x-request-id': 'revenuecat-webhook-retryable-1',
    }));

    expect(response.status).toBe(503);
    expectPrivateNoStoreTraceHeaders(response, 'revenuecat-webhook-retryable-1');
  });
});

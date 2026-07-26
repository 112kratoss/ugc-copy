import { describe, expect, it, vi } from 'vitest';

import type { ProviderFetchTelemetryEvent } from '@/lib/provider-fetch';
import {
  PAYMENT_WEBHOOK_PROCESSING_SERVICE_NAMES,
  RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
  REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
  recordPaymentWebhookProcessingFailure,
  recordProviderDependencyEvent,
} from '@/lib/provider-dependency-telemetry';

describe('provider dependency telemetry', () => {
  it('stores sanitized provider dependency events for ops dashboards', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => {
      void _row;
      return { error: null };
    });
    const client = {
      from: vi.fn(() => ({ insert })),
    };
    const event: ProviderFetchTelemetryEvent = {
      type: 'provider_fetch',
      serviceName: 'KIE task status',
      requestId: 'api-request-1',
      outcome: 'http_error',
      method: 'GET',
      host: 'api.kie.ai',
      providerTaskId: 'task-123',
      timeoutMs: 10_000,
      durationMs: 2345,
      status: 502,
      ok: false,
      errorName: 'ProviderError',
    };

    await recordProviderDependencyEvent(event, client as never);

    expect(client.from).toHaveBeenCalledWith('provider_dependency_events');
    expect(insert).toHaveBeenCalledWith({
      service_name: 'KIE task status',
      request_id: 'api-request-1',
      outcome: 'http_error',
      method: 'GET',
      host: 'api.kie.ai',
      provider_task_id: 'task-123',
      timeout_ms: 10_000,
      duration_ms: 2345,
      status: 502,
      ok: false,
      error_name: 'ProviderError',
    });
  });

  it('persists the model attribution when the event carries one', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => {
      void _row;
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ insert })) };
    const event: ProviderFetchTelemetryEvent = {
      type: 'provider_fetch',
      serviceName: 'KIE task creation',
      modelId: 'nano-banana-2',
      outcome: 'timeout',
      method: 'POST',
      host: 'api.kie.ai',
      timeoutMs: 30_000,
      durationMs: 30_000,
    };

    await recordProviderDependencyEvent(event, client as never);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ model_id: 'nano-banana-2' }));
  });

  it('omits the column entirely for calls with no model behind them', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => {
      void _row;
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ insert })) };
    const event: ProviderFetchTelemetryEvent = {
      type: 'provider_fetch',
      serviceName: 'Razorpay',
      outcome: 'network_error',
      method: 'POST',
      host: 'api.razorpay.com',
      timeoutMs: 5_000,
      durationMs: 120,
    };

    await recordProviderDependencyEvent(event, client as never);

    // Absent rather than null or 'unknown': a placeholder would accumulate all
    // non-generation traffic under one key and skew per-model rates.
    expect(insert.mock.calls[0][0]).not.toHaveProperty('model_id');
  });

  it('records payment webhook processing failures under their dedicated service name', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => {
      void _row;
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ insert })) };

    await recordPaymentWebhookProcessingFailure({
      serviceName: RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode: 'credit_transaction_settlement_failed',
    }, client as never);

    expect(client.from).toHaveBeenCalledWith('provider_dependency_events');
    expect(insert).toHaveBeenCalledWith({
      service_name: 'razorpay-webhook-processing',
      outcome: 'http_error',
      method: 'POST',
      host: null,
      timeout_ms: 0,
      duration_ms: 0,
      status: 500,
      ok: false,
      error_name: 'credit_transaction_settlement_failed',
    });
  });

  it('records the response status the webhook actually returned to the provider', async () => {
    const insert = vi.fn(async (_row: Record<string, unknown>) => {
      void _row;
      return { error: null };
    });
    const client = { from: vi.fn(() => ({ insert })) };

    await recordPaymentWebhookProcessingFailure({
      serviceName: REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode: 'refund_purchase_not_synced',
      status: 503,
    }, client as never);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      service_name: 'revenuecat-webhook-processing',
      status: 503,
      error_name: 'refund_purchase_not_synced',
    }));
  });

  it('never throws when recording a payment webhook failure fails', async () => {
    const insert = vi.fn(async () => {
      throw new Error('insert unavailable');
    });
    const client = { from: vi.fn(() => ({ insert })) };

    await expect(recordPaymentWebhookProcessingFailure({
      serviceName: RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode: 'credit_refund_reconciliation_failed',
    }, client as never)).resolves.toBeUndefined();
  });

  it('exposes both payment webhook service names for backend health matching', () => {
    expect(PAYMENT_WEBHOOK_PROCESSING_SERVICE_NAMES).toEqual([
      'razorpay-webhook-processing',
      'revenuecat-webhook-processing',
    ]);
  });
});

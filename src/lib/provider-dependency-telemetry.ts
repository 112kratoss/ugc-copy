import type { SupabaseClient } from '@supabase/supabase-js';
import { logBackendWarning } from '@/lib/backend-logger';

import type { ProviderFetchTelemetryEvent } from '@/lib/provider-fetch';
import { createServiceClient } from '@/lib/server-helpers';

type ProviderDependencyInsert = {
  service_name: string;
  request_id?: string;
  model_id?: string;
  outcome: ProviderFetchTelemetryEvent['outcome'];
  method: string;
  host: string | null;
  provider_task_id?: string;
  timeout_ms: number;
  duration_ms: number;
  status?: number;
  ok?: boolean;
  error_name?: string;
};

export const RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME = 'razorpay-webhook-processing';
export const REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME = 'revenuecat-webhook-processing';

/**
 * Service identifiers under which payment webhook processing failures are
 * durably recorded. Backend health raises a dedicated degraded issue code
 * whenever any event with one of these names lands in its lookback window.
 */
export const PAYMENT_WEBHOOK_PROCESSING_SERVICE_NAMES: readonly string[] = [
  RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME,
  REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
];

export type PaymentWebhookProcessingFailure = {
  serviceName:
    | typeof RAZORPAY_WEBHOOK_PROCESSING_SERVICE_NAME
    | typeof REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME;
  /** Stable machine-readable reason, e.g. 'credit_transaction_settlement_failed'. */
  failureCode: string;
  /** HTTP status the webhook returned to the provider (defaults to 500). */
  status?: number;
};

function hasSupabaseServiceConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
}

function toProviderDependencyInsert(event: ProviderFetchTelemetryEvent): ProviderDependencyInsert {
  return {
    service_name: event.serviceName,
    ...(event.requestId ? { request_id: event.requestId } : {}),
    ...(event.modelId ? { model_id: event.modelId } : {}),
    outcome: event.outcome,
    method: event.method,
    host: event.host,
    ...(event.providerTaskId ? { provider_task_id: event.providerTaskId } : {}),
    timeout_ms: event.timeoutMs,
    duration_ms: event.durationMs,
    ...(typeof event.status === 'number' ? { status: event.status } : {}),
    ...(typeof event.ok === 'boolean' ? { ok: event.ok } : {}),
    ...(event.errorName ? { error_name: event.errorName } : {}),
  };
}

function errorMessage(error: unknown): string {
  if (!error) return 'unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'unknown error');
  }
  return String(error);
}

export async function recordProviderDependencyEvent(
  event: ProviderFetchTelemetryEvent,
  client?: SupabaseClient,
) {
  const supabase = client ?? (hasSupabaseServiceConfig() ? createServiceClient() : null);
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('provider_dependency_events')
      .insert(toProviderDependencyInsert(event));

    if (error) {
      logBackendWarning('provider_dependency_telemetry_insert_failed', {
    serviceName: event.serviceName,
        outcome: event.outcome,
        requestId: event.requestId,
        error: errorMessage(error),
  });
    }
  } catch (error) {
    logBackendWarning('provider_dependency_telemetry_insert_failed', {
    serviceName: event.serviceName,
      outcome: event.outcome,
      requestId: event.requestId,
      error: errorMessage(error),
  });
  }
}

/**
 * Durably records a payment webhook processing failure (a failure that occurs
 * after signature verification, e.g. a failed add_credits RPC or an
 * unreconcilable refund) into the provider_dependency_events pipeline so ops
 * alerting does not depend on ephemeral logs.
 *
 * Reuses the provider dependency insert path, so it never throws: a recording
 * failure is logged and must not change the webhook response.
 */
export async function recordPaymentWebhookProcessingFailure(
  failure: PaymentWebhookProcessingFailure,
  client?: SupabaseClient,
) {
  await recordProviderDependencyEvent({
    type: 'provider_fetch',
    serviceName: failure.serviceName,
    outcome: 'http_error',
    method: 'POST',
    host: null,
    timeoutMs: 0,
    durationMs: 0,
    status: failure.status ?? 500,
    ok: false,
    errorName: failure.failureCode,
  }, client);
}

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

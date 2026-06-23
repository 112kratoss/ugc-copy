import { describe, expect, it, vi } from 'vitest';

import type { ProviderFetchTelemetryEvent } from '@/lib/provider-fetch';
import { recordProviderDependencyEvent } from '@/lib/provider-dependency-telemetry';

describe('provider dependency telemetry', () => {
  it('stores sanitized provider dependency events for ops dashboards', async () => {
    const insert = vi.fn(async () => ({ error: null }));
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
});

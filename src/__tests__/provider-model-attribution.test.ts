import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWithProviderTimeout,
  withProviderFetchRequestId,
  withProviderModel,
  type ProviderFetchTelemetryEvent,
} from '@/lib/provider-fetch';

vi.mock('@/lib/provider-dependency-telemetry', () => ({
  recordProviderDependencyEvent: vi.fn(),
}));

function okResponse() {
  return new Response('{}', { status: 200 });
}

function errorResponse() {
  return new Response('{}', { status: 500 });
}

/**
 * Telemetry is only emitted for non-success or slow calls, so these tests drive
 * a 500 to make the event observable without faking timers.
 */
async function captureTelemetry(run: () => Promise<unknown>): Promise<ProviderFetchTelemetryEvent> {
  const { recordProviderDependencyEvent } = await import('@/lib/provider-dependency-telemetry');
  await run();
  const mock = vi.mocked(recordProviderDependencyEvent);
  expect(mock).toHaveBeenCalledTimes(1);
  return mock.mock.calls[0][0];
}

describe('provider model attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attributes a provider call to the ambient model', async () => {
    const event = await captureTelemetry(() => withProviderModel('nano-banana-2', () => fetchWithProviderTimeout(
      'https://api.kie.ai/api/v1/jobs/createTask',
      { method: 'POST' },
      1_000,
      async () => errorResponse(),
      'KIE task creation',
    )));

    expect(event.modelId).toBe('nano-banana-2');
    expect(event.serviceName).toBe('KIE task creation');
  });

  it('leaves a call with no model scope unattributed rather than guessing', async () => {
    const event = await captureTelemetry(() => fetchWithProviderTimeout(
      'https://api.razorpay.com/v1/orders',
      { method: 'POST' },
      1_000,
      async () => errorResponse(),
      'Razorpay',
    ));

    expect(event.modelId).toBeUndefined();
    expect('modelId' in event).toBe(false);
  });

  it('treats a blank model as no attribution', async () => {
    const event = await captureTelemetry(() => withProviderModel('   ', () => fetchWithProviderTimeout(
      'https://api.kie.ai/api/v1/jobs/recordInfo',
      {},
      1_000,
      async () => errorResponse(),
      'KIE task status',
    )));

    expect(event.modelId).toBeUndefined();
  });

  it('keeps the surrounding request id when a model scope is opened', async () => {
    const event = await captureTelemetry(() => withProviderFetchRequestId('req-42', () => withProviderModel(
      'veo-3.1',
      () => fetchWithProviderTimeout(
        'https://api.kie.ai/api/v1/veo/record-info',
        {},
        1_000,
        async () => errorResponse(),
        'KIE Veo status',
      ),
    )));

    // The model scope must merge into the trace, not replace it — otherwise
    // opening one would silently drop request correlation.
    expect(event.requestId).toBe('req-42');
    expect(event.modelId).toBe('veo-3.1');
  });

  it('restores the outer model once an inner scope closes', async () => {
    const { recordProviderDependencyEvent } = await import('@/lib/provider-dependency-telemetry');

    await withProviderModel('outer-model', async () => {
      await withProviderModel('inner-model', () => fetchWithProviderTimeout(
        'https://api.kie.ai/a', {}, 1_000, async () => errorResponse(), 'KIE a',
      ));
      await fetchWithProviderTimeout(
        'https://api.kie.ai/b', {}, 1_000, async () => errorResponse(), 'KIE b',
      );
    });

    const events = vi.mocked(recordProviderDependencyEvent).mock.calls.map(([event]) => event);
    expect(events.map((event) => event.modelId)).toEqual(['inner-model', 'outer-model']);
  });

  it('does not attribute a successful fast call, which emits no telemetry at all', async () => {
    const { recordProviderDependencyEvent } = await import('@/lib/provider-dependency-telemetry');

    await withProviderModel('nano-banana-2', () => fetchWithProviderTimeout(
      'https://api.kie.ai/api/v1/jobs/createTask',
      { method: 'POST' },
      1_000,
      async () => okResponse(),
      'KIE task creation',
    ));

    expect(recordProviderDependencyEvent).not.toHaveBeenCalled();
  });
});

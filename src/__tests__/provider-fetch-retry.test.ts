import { describe, expect, it } from 'vitest';

import {
  computeProviderRetryDelayMs,
  ExternalServiceTimeoutError,
  fetchWithProviderRetry,
  isIdempotentProviderMethod,
  isRetryableProviderResponse,
  PROVIDER_STATUS_POLL_RETRY_POLICY,
  type ProviderRetryPolicy,
} from '@/lib/provider-fetch';
import { setBackendLogSink } from '@/lib/backend-logger';

const POLICY: ProviderRetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

function silenceLogs() {
  return setBackendLogSink(() => {});
}

function jsonResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ status }), { status, headers });
}

/** Records the delays that would have been slept instead of waiting. */
function createSleepRecorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (delayMs: number) => {
      delays.push(delayMs);
    },
  };
}

describe('provider fetch retry', () => {
  it('returns a successful response without retrying', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher);

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    restore();
  });

  it('retries a retryable status on an idempotent request and returns the eventual success', async () => {
    const restore = silenceLogs();
    const recorder = createSleepRecorder();
    const statuses = [503, 502, 200];
    let calls = 0;
    const fetcher = (async () => jsonResponse(statuses[calls++])) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry(
      'https://provider.test/status',
      { method: 'GET' },
      1_000,
      POLICY,
      fetcher,
      'Kie status',
      { sleep: recorder.sleep, random: () => 1 },
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(recorder.delays).toEqual([100, 200]);
    restore();
  });

  it('never retries a non-idempotent request by default, so a paid task is not created twice', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse(503);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry(
      'https://provider.test/tasks',
      { method: 'POST' },
      1_000,
      POLICY,
      fetcher,
      'Kie task create',
      { sleep: async () => {} },
    );

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    restore();
  });

  it('retries a non-idempotent request only when explicitly opted in', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(500) : jsonResponse(200);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry(
      'https://provider.test/tasks',
      { method: 'POST' },
      1_000,
      { ...POLICY, retryNonIdempotent: true },
      fetcher,
      'Kie task create',
      { sleep: async () => {} },
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    restore();
  });

  it('stops at maxAttempts and returns the last retryable response', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse(503);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry(
      'https://provider.test/status',
      {},
      1_000,
      POLICY,
      fetcher,
      'Kie status',
      { sleep: async () => {} },
    );

    expect(response.status).toBe(503);
    expect(calls).toBe(3);
    restore();
  });

  it('does not retry a non-retryable client error', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse(400);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher);

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
    restore();
  });

  it('retries a network error raised before any response', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('network unreachable');
      return jsonResponse(200);
    }) as unknown as typeof fetch;

    const response = await fetchWithProviderRetry(
      'https://provider.test/status',
      {},
      1_000,
      POLICY,
      fetcher,
      'Kie status',
      { sleep: async () => {} },
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    restore();
  });

  it('rethrows a network error once attempts are exhausted', async () => {
    const restore = silenceLogs();
    const fetcher = (async () => {
      throw new TypeError('network unreachable');
    }) as unknown as typeof fetch;

    await expect(
      fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher, 'Kie status', {
        sleep: async () => {},
      }),
    ).rejects.toThrow('network unreachable');
    restore();
  });

  it('never retries a timeout, so user-visible latency cannot stack', async () => {
    const restore = silenceLogs();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      const signal = AbortSignal.timeout(0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      void signal;
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as unknown as typeof fetch;

    await expect(
      fetchWithProviderRetry('https://provider.test/status', {}, 1, POLICY, fetcher, 'Kie status', {
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(ExternalServiceTimeoutError);

    expect(calls).toBe(1);
    restore();
  });

  it('honours a Retry-After header instead of the computed backoff', async () => {
    const restore = silenceLogs();
    const recorder = createSleepRecorder();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(429, { 'retry-after': '2' }) : jsonResponse(200);
    }) as unknown as typeof fetch;

    await fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher, 'Kie status', {
      sleep: recorder.sleep,
    });

    expect(recorder.delays).toEqual([2_000]);
    restore();
  });

  it('caps an absurd Retry-After value', async () => {
    const restore = silenceLogs();
    const recorder = createSleepRecorder();
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse(429, { 'retry-after': '3600' }) : jsonResponse(200);
    }) as unknown as typeof fetch;

    await fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher, 'Kie status', {
      sleep: recorder.sleep,
    });

    expect(recorder.delays).toEqual([10_000]);
    restore();
  });

  it('emits a structured retry log line', async () => {
    const records: Record<string, unknown>[] = [];
    const restore = setBackendLogSink((record) => records.push(record));
    let calls = 0;
    const fetcher = (async () => (calls++ === 0 ? jsonResponse(503) : jsonResponse(200))) as unknown as typeof fetch;

    await fetchWithProviderRetry('https://provider.test/status', {}, 1_000, POLICY, fetcher, 'Kie status', {
      sleep: async () => {},
    });

    expect(records).toHaveLength(1);
    expect(records[0].msg).toBe('provider_fetch_retry');
    expect(records[0].serviceName).toBe('Kie status');
    expect(records[0].status).toBe(503);
    expect(records[0].attempt).toBe(1);
    restore();
  });

  describe('retry predicates', () => {
    it('classifies idempotent methods', () => {
      expect(isIdempotentProviderMethod('get')).toBe(true);
      expect(isIdempotentProviderMethod('HEAD')).toBe(true);
      expect(isIdempotentProviderMethod('POST')).toBe(false);
      expect(isIdempotentProviderMethod('PATCH')).toBe(false);
    });

    it('classifies retryable statuses', () => {
      expect(isRetryableProviderResponse(429)).toBe(true);
      expect(isRetryableProviderResponse(503)).toBe(true);
      expect(isRetryableProviderResponse(400)).toBe(false);
      expect(isRetryableProviderResponse(401)).toBe(false);
      expect(isRetryableProviderResponse(404)).toBe(false);
    });

    it('applies full jitter bounded by the exponential cap', () => {
      expect(computeProviderRetryDelayMs(1, POLICY, () => 1)).toBe(100);
      expect(computeProviderRetryDelayMs(2, POLICY, () => 1)).toBe(200);
      expect(computeProviderRetryDelayMs(3, POLICY, () => 1)).toBe(400);
      expect(computeProviderRetryDelayMs(1, POLICY, () => 0)).toBe(0);
      expect(computeProviderRetryDelayMs(99, POLICY, () => 1)).toBe(POLICY.maxDelayMs);
    });

    it('ships a conservative default status-poll policy', () => {
      expect(PROVIDER_STATUS_POLL_RETRY_POLICY.maxAttempts).toBe(3);
      expect(PROVIDER_STATUS_POLL_RETRY_POLICY.retryNonIdempotent).toBeUndefined();
    });
  });
});

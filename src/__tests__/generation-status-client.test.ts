import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchGenerationStatus,
  getGenerationStatusRetryDelayMs,
  waitForNextGenerationStatusPoll,
} from '@/lib/generation-status-client';

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchGenerationStatus', () => {
  it('throws the API error immediately for a non-success response', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'Your session has expired.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-1',
      accessToken: 'expired-token',
      fetchImpl,
    })).rejects.toThrow('Your session has expired.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses a deterministic fallback for a non-JSON error response', async () => {
    const fetchImpl = vi.fn(async () => new Response('gateway unavailable', { status: 503 }));

    await expect(fetchGenerationStatus({
      url: '/api/generate-video?id=prediction-2',
      accessToken: 'token',
      fetchImpl,
    })).rejects.toThrow('Generation status request failed (503).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful response with an invalid status payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'unknown-provider-state' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    ));

    await expect(fetchGenerationStatus({
      url: '/api/generate?id=prediction-3',
      accessToken: 'token',
      fetchImpl,
    })).rejects.toThrow('Invalid generation status response.');
  });

  it('returns valid processing and successful payloads unchanged', async () => {
    const processing = {
      status: 'processing' as const,
      timing: null,
    };
    const succeeded = {
      status: 'succeeded' as const,
      output: 'https://example.com/result.png',
      outputs: ['https://example.com/result.png'],
      timing: null,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(processing), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(succeeded), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-4',
      accessToken: 'token',
      fetchImpl,
    })).resolves.toEqual(processing);
    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-4',
      accessToken: 'token',
      fetchImpl,
    })).resolves.toEqual(succeeded);
    expect(fetchImpl).toHaveBeenCalledWith('/api/generate-image?id=prediction-4', {
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('forwards cancellation to the underlying request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'processing', retryAfterMs: 15_000 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-5',
      accessToken: 'token',
      signal: controller.signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/generate-image?id=prediction-5', {
      headers: { Authorization: 'Bearer token' },
      signal: controller.signal,
    });
  });

  it('honors server retry hints with bounded positive jitter', () => {
    expect(getGenerationStatusRetryDelayMs(15_000, () => 0)).toBe(15_000);
    expect(getGenerationStatusRetryDelayMs(15_000, () => 1)).toBe(16_000);
    expect(getGenerationStatusRetryDelayMs(100, () => 0)).toBe(1_000);
    expect(getGenerationStatusRetryDelayMs(90_000, () => 0)).toBe(30_000);
    expect(getGenerationStatusRetryDelayMs(undefined, () => 0)).toBe(15_000);
  });

  it('waits for the retry hint and can be cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const completed = vi.fn();
    const waiting = waitForNextGenerationStatusPoll(2_000, {
      signal: controller.signal,
      random: () => 0,
      documentRef: null,
    }).then(completed);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(completed).toHaveBeenCalledTimes(1);

    const cancelled = waitForNextGenerationStatusPoll(2_000, {
      signal: controller.signal,
      random: () => 0,
      documentRef: null,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });
});

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  announceGenerationSettledOnPage,
  fetchGenerationStatus,
  fetchGenerationStatusWithRetry,
  GenerationStatusRequestError,
  getGenerationStatusRetryDelayMs,
  subscribeToGenerationSettledOnPage,
  useAnnounceRunSettledOnPage,
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
    await expect(fetchGenerationStatus({
      url: '/api/generate-image?id=prediction-1',
      accessToken: 'expired-token',
      fetchImpl,
    })).rejects.toBeInstanceOf(GenerationStatusRequestError);
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

function statusResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('fetchGenerationStatusWithRetry', () => {
  const url = '/api/generate-video?id=prediction-9';
  const noWait = [0, 0, 0];

  it('rides out a server fault and returns the one answer that came through', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(statusResponse({ error: 'Failed to fetch generation status' }, 500))
      .mockResolvedValueOnce(statusResponse({ status: 'processing', retryAfterMs: 15_000 }));

    await expect(fetchGenerationStatusWithRetry({
      url,
      getAccessToken: () => 'token',
      delaysMs: noWait,
      fetchImpl,
    })).resolves.toEqual({ status: 'processing', retryAfterMs: 15_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads the token again after a 401 and retries with the fresh one', async () => {
    const getAccessToken = vi.fn()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('refreshed-token');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(statusResponse({ error: 'Unauthorized: Please log in to check generation status' }, 401))
      .mockResolvedValueOnce(statusResponse({ status: 'succeeded', output: 'https://cdn.test/out.mp4' }));

    await expect(fetchGenerationStatusWithRetry({ url, getAccessToken, delaysMs: noWait, fetchImpl }))
      .resolves.toMatchObject({ status: 'succeeded' });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, url, { headers: { Authorization: 'Bearer expired-token' } });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, url, { headers: { Authorization: 'Bearer refreshed-token' } });
  });

  it('retries a dropped connection and a moment with no session', async () => {
    const getAccessToken = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('token');
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(statusResponse({ status: 'waiting' }));

    await expect(fetchGenerationStatusWithRetry({ url, getAccessToken, delaysMs: noWait, fetchImpl }))
      .resolves.toEqual({ status: 'waiting' });
    expect(getAccessToken).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws the last error once every attempt has failed', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(statusResponse({ error: 'first' }, 503))
      .mockResolvedValueOnce(statusResponse({ error: 'second' }, 502))
      .mockResolvedValueOnce(statusResponse({ error: 'third' }, 500))
      .mockResolvedValueOnce(statusResponse({ error: 'fourth' }, 504));

    await expect(fetchGenerationStatusWithRetry({
      url,
      getAccessToken: () => 'token',
      delaysMs: noWait,
      fetchImpl,
    })).rejects.toMatchObject({ message: 'fourth', status: 504 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry an answer that would come back the same', async () => {
    const fetchImpl = vi.fn(async () => statusResponse({ error: 'Generation not found' }, 404));

    await expect(fetchGenerationStatusWithRetry({
      url,
      getAccessToken: () => 'token',
      delaysMs: noWait,
      fetchImpl,
    })).rejects.toMatchObject({ message: 'Generation not found', status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits 2, 5 and 10 seconds between attempts by default', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => statusResponse({ error: 'down' }, 503));
    const outcome = fetchGenerationStatusWithRetry({ url, getAccessToken: () => 'token', fetchImpl })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await expect(outcome).resolves.toMatchObject({ status: 503 });
  });

  it('stops at once when the poll is cancelled during a wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => statusResponse({ error: 'down' }, 503));
    const outcome = fetchGenerationStatusWithRetry({
      url,
      getAccessToken: () => 'token',
      signal: controller.signal,
      fetchImpl,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// A creator that showed its run end tells the shell's run toasts (GenerationNotifications), so the
// toast does not say it again over the creator's Publish.
describe('a run settled on its own page', () => {
  it('reaches a subscriber with the run and how it ended, until it unsubscribes', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationSettledOnPage(heard);
    announceGenerationSettledOnPage({ id: 'gen-1', status: 'succeeded' });
    expect(heard).toHaveBeenCalledWith({ id: 'gen-1', status: 'succeeded' });
    unsubscribe();
    announceGenerationSettledOnPage({ id: 'gen-2', status: 'failed' });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('is said by a creator once its canvas shows the end, and only then', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationSettledOnPage(heard);
    type Props = { id: string | null; status: 'succeeded' | 'failed' | null };
    const { rerender } = renderHook<void, Props>(
      ({ id, status }) => useAnnounceRunSettledOnPage(id, status),
      { initialProps: { id: 'gen-1', status: null } },
    );
    expect(heard).not.toHaveBeenCalled();
    rerender({ id: 'gen-1', status: 'succeeded' });
    expect(heard).toHaveBeenCalledWith({ id: 'gen-1', status: 'succeeded' });
    // The same end again says nothing more; a start with no answer yet names no run.
    rerender({ id: 'gen-1', status: 'succeeded' });
    rerender({ id: null, status: 'failed' });
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  announceGenerationFollowedOnPage,
  announceGenerationLeftOnPage,
  announceGenerationSettledOnPage,
  clearGenerationsOnPage,
  fetchGenerationStatus,
  fetchGenerationStatusWithRetry,
  GenerationStatusRequestError,
  getGenerationStatusRetryDelayMs,
  readGenerationsOnPage,
  subscribeToGenerationOnPage,
  useAnnounceRunOnPage,
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

// What a creator tells the shell's run toasts (GenerationNotifications) of the run it shows, so the
// toast does not say its end again over the creator's Publish, whichever poll read the end first.
describe('a run on its own page', () => {
  type Props = { id: string | null; following: boolean; settled: 'succeeded' | 'failed' | null };
  const said = (heard: ReturnType<typeof vi.fn>) => heard.mock.calls.map(([change]) => change);

  beforeEach(() => {
    clearGenerationsOnPage();
  });

  it('is followed, then settled; settled outlives the page letting go, and a subscriber hears each once', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationOnPage(heard);
    announceGenerationFollowedOnPage('gen-1');
    announceGenerationFollowedOnPage('gen-1');
    expect(readGenerationsOnPage().get('gen-1')).toBe('following');
    announceGenerationSettledOnPage({ id: 'gen-1', status: 'succeeded' });
    announceGenerationLeftOnPage('gen-1');
    expect(readGenerationsOnPage().get('gen-1')).toBe('succeeded');
    expect(said(heard)).toEqual([
      { id: 'gen-1', state: 'following' },
      { id: 'gen-1', state: 'succeeded' },
    ]);
    unsubscribe();
    announceGenerationFollowedOnPage('gen-2');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('is forgotten when the page lets go of it at work, once', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationOnPage(heard);
    announceGenerationFollowedOnPage('gen-1');
    announceGenerationLeftOnPage('gen-1');
    announceGenerationLeftOnPage('gen-1');
    expect(readGenerationsOnPage().has('gen-1')).toBe(false);
    expect(said(heard)).toEqual([
      { id: 'gen-1', state: 'following' },
      { id: 'gen-1', state: 'left' },
    ]);
    unsubscribe();
  });

  it('is what a creator says of the run it shows: followed while shown, settled once the canvas shows the end', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationOnPage(heard);
    const { rerender, unmount } = renderHook<void, Props>(
      ({ id, following, settled }) => useAnnounceRunOnPage(id, following, settled),
      { initialProps: { id: null, following: false, settled: null } },
    );
    // A start with no answer yet names no run.
    expect(heard).not.toHaveBeenCalled();
    rerender({ id: 'gen-1', following: true, settled: null });
    rerender({ id: 'gen-1', following: true, settled: null });
    expect(said(heard)).toEqual([{ id: 'gen-1', state: 'following' }]);
    // The end shown, said once; the same end again says nothing more.
    rerender({ id: 'gen-1', following: true, settled: 'succeeded' });
    rerender({ id: 'gen-1', following: true, settled: 'succeeded' });
    expect(said(heard)).toEqual([{ id: 'gen-1', state: 'following' }, { id: 'gen-1', state: 'succeeded' }]);
    // Leaving the page after the end changes nothing: the end stays said.
    unmount();
    expect(heard).toHaveBeenCalledTimes(2);
    expect(readGenerationsOnPage().get('gen-1')).toBe('succeeded');
    unsubscribe();
  });

  it('lets go of a run the page loses sight of at work, and of one it leaves at work', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeToGenerationOnPage(heard);
    const { rerender, unmount } = renderHook<void, Props>(
      ({ id, following, settled }) => useAnnounceRunOnPage(id, following, settled),
      { initialProps: { id: 'gen-1', following: true, settled: null } },
    );
    // Left to the server: out of the page's sight.
    rerender({ id: 'gen-1', following: false, settled: null });
    expect(readGenerationsOnPage().has('gen-1')).toBe(false);
    // Shown again, then the page goes.
    rerender({ id: 'gen-1', following: true, settled: null });
    unmount();
    expect(said(heard)).toEqual([
      { id: 'gen-1', state: 'following' },
      { id: 'gen-1', state: 'left' },
      { id: 'gen-1', state: 'following' },
      { id: 'gen-1', state: 'left' },
    ]);
    unsubscribe();
  });
});

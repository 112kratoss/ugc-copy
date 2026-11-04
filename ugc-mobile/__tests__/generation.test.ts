import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GENERATION_POLL_MAX_DELAY_MS,
  GENERATION_POLL_UNWOKEN_MAX_DELAY_MS,
  generationStillProcessingMessage,
  getGenerationOutput,
  getGenerationOutputs,
  generationPollMaxDelayMs,
  getGenerationPollBackoffMs,
  getPollDelayMs,
  isGenerationFinished,
  pollGenerationStatus,
} from '../lib/generation';
import {
  announceGenerationSettledPush,
  isGenerationSettledPush,
  subscribeToGenerationSettledPush,
  wakeOnGenerationSettledOrAppActive,
} from '../lib/generation-settled-push';

describe('generation polling helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recognizes terminal provider states', () => {
    expect(isGenerationFinished('succeeded')).toBe(true);
    expect(isGenerationFinished('failed')).toBe(true);
    // The legacy spelling the database still allows; it used to run for ever.
    expect(isGenerationFinished('completed')).toBe(true);
    expect(isGenerationFinished('processing')).toBe(false);
  });

  it('prefers the first output URL from a multi-output response', () => {
    expect(getGenerationOutput({ status: 'succeeded', output: 'fallback.png', outputs: ['first.png', 'second.png'] })).toBe('first.png');
    expect(getGenerationOutput({ status: 'succeeded', output: 'single.mp4' })).toBe('single.mp4');
  });

  it('reads every output of a run that returned several, the primary first', () => {
    // Grok Imagine answers with several options; the result showed only the first.
    expect(getGenerationOutputs({ status: 'succeeded', output: 'first.png', outputs: ['first.png', 'second.png', 'third.png'] }))
      .toEqual(['first.png', 'second.png', 'third.png']);
    expect(getGenerationOutputs({ status: 'succeeded', output: 'single.mp4' })).toEqual(['single.mp4']);
    expect(getGenerationOutputs({ status: 'succeeded', output: 'single.mp4', outputs: [] })).toEqual(['single.mp4']);
    expect(getGenerationOutputs({ status: 'succeeded', outputs: ['', 'kept.png'] })).toEqual(['kept.png']);
    expect(getGenerationOutputs({ status: 'processing', output: null })).toEqual([]);
  });

  it('polls until a generation succeeds and emits tick updates', async () => {
    vi.useFakeTimers();
    const statuses = [
      { status: 'processing' },
      { status: 'succeeded', outputs: ['done.png'] },
    ];
    const getStatus = vi.fn(async () => statuses.shift() ?? { status: 'failed' });
    const onTick = vi.fn();

    const resultPromise = pollGenerationStatus(getStatus, {
      intervalMs: 1000,
      timeoutMs: 5000,
      onTick,
      random: () => 0,
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({ status: 'succeeded', outputs: ['done.png'] });
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('honors bounded server retry hints and adds only positive jitter', () => {
    expect(getPollDelayMs(15_000, 4_000, () => 0)).toBe(15_000);
    expect(getPollDelayMs(15_000, 4_000, () => 1)).toBe(16_000);
    expect(getPollDelayMs(100, 4_000, () => 0)).toBe(1_000);
    expect(getPollDelayMs(90_000, 4_000, () => 0)).toBe(30_000);
    expect(getPollDelayMs(undefined, 4_000, () => 0)).toBe(4_000);
  });

  it('waits for the app readiness gate before making a status request', async () => {
    const status = { status: 'succeeded', output: 'done.png' };
    const getStatus = vi.fn(async () => status);
    let release!: () => void;
    const waitUntilReady = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    const resultPromise = pollGenerationStatus(getStatus, { waitUntilReady });
    await Promise.resolve();
    expect(getStatus).not.toHaveBeenCalled();
    release();

    await expect(resultPromise).resolves.toEqual(status);
    expect(waitUntilReady).toHaveBeenCalledTimes(1);
  });

  it('points a registered account at Alerts when it stops watching a run that is still going', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => ({ status: 'processing' }));

    const resultPromise = pollGenerationStatus(getStatus, { intervalMs: 1000, timeoutMs: 2500, random: () => 0 });
    const settled = expect(resultPromise).rejects.toThrow('Generation is still processing. Check Alerts in a few minutes.');
    await vi.advanceTimersByTimeAsync(3000);

    await settled;
  });

  it('tells a guest, who gets no push and finds Alerts behind a sign-in, to sign in or come back', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => ({ status: 'waiting' }));

    const resultPromise = pollGenerationStatus(getStatus, { intervalMs: 1000, timeoutMs: 2500, random: () => 0, isGuest: true });
    const settled = expect(resultPromise).rejects.toThrow(
      'Generation is still processing. Sign in to get an alert when it’s done. Until then, come back to this screen.',
    );
    await vi.advanceTimersByTimeAsync(3000);

    await settled;
    expect(generationStillProcessingMessage(true)).not.toContain('Check Alerts');
    expect(generationStillProcessingMessage(false)).toContain('Check Alerts');
  });

  // Every read of a run still working costs the server two lookups, three lock
  // writes and up to one provider call; runs take one to four minutes.
  describe('the creator\'s reads of a run it watches', () => {
    /** When the last `readTimes` started, for an option that reads the clock. */
    let startedAtForCap = 0;

    /** When each read was made, in seconds from the first, for a run that never ends. */
    async function readTimes(options: Parameters<typeof pollGenerationStatus>[1], untilMs: number, status: Record<string, unknown> = { status: 'processing' }) {
      vi.useFakeTimers();
      const start = Date.now();
      startedAtForCap = start;
      const times: number[] = [];
      const getStatus = vi.fn(async () => {
        times.push((Date.now() - start) / 1000);
        return status as { status: string };
      });
      const polling = pollGenerationStatus(getStatus, { random: () => 0, timeoutMs: untilMs, ...options }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(untilMs);
      // The wait under way at the deadline ends, and the poll gives up without another read.
      await vi.advanceTimersByTimeAsync(GENERATION_POLL_MAX_DELAY_MS + 1_000);
      await polling;
      return times;
    }

    it('waits 8 s, then half as long again each time, to 30 s at most when a completion push can wake it', async () => {
      expect([0, 1, 2, 3, 4, 5, 9].map((index) => getGenerationPollBackoffMs(index))).toEqual([8_000, 12_000, 18_000, 27_000, 30_000, 30_000, 30_000]);
      expect(GENERATION_POLL_MAX_DELAY_MS).toBe(30_000);

      // A four-minute run is read 11 times where a fixed 15 s read it 17.
      const times = await readTimes({ maxDelayMs: GENERATION_POLL_MAX_DELAY_MS }, 246_000);
      expect(times).toEqual([0, 8, 20, 38, 65, 95, 125, 155, 185, 215, 245]);
      expect((await readTimes({ intervalMs: 15_000 }, 246_000)).length).toBe(17);
    });

    // Owner, via the review: no push can wake a guest's poll, nor one on a
    // phone whose notifications are off, so those keep the old pace at most.
    it('waits 15 s at most when no completion push can wake it', async () => {
      expect(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS).toBe(15_000);
      expect([0, 1, 2, 3].map((index) => getGenerationPollBackoffMs(index, GENERATION_POLL_UNWOKEN_MAX_DELAY_MS)))
        .toEqual([8_000, 12_000, 15_000, 15_000]);
      expect(await readTimes({}, 51_000)).toEqual([0, 8, 20, 35, 50]);
    });

    it('never reads sooner than the server asks, nor sooner than the backoff because the server asks for less', async () => {
      // Throttled: the server reads the provider once per 15 s at most.
      expect(await readTimes({}, 31_000, { status: 'processing', retryAfterMs: 15_000 })).toEqual([0, 15, 30]);
      // Another read holds the run's lock: 2 s, which the backoff outlasts.
      expect(await readTimes({}, 21_000, { status: 'processing', retryAfterMs: 2_000 })).toEqual([0, 8, 20]);
    });

    // Review finding 4.
    it('never reads before the server asks, however soon a push comes', async () => {
      vi.useFakeTimers();
      const getStatus = vi.fn(async () => ({ status: 'processing', retryAfterMs: 15_000 }));
      const polling = pollGenerationStatus(getStatus, { random: () => 0, wake: subscribeToGenerationSettledPush, maxDelayMs: GENERATION_POLL_MAX_DELAY_MS, timeoutMs: 20_000 })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(getStatus).toHaveBeenCalledTimes(1);
      announceGenerationSettledPush();
      await vi.advanceTimersByTimeAsync(11_999);
      expect(getStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(getStatus).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(31_000);
      await polling;
    });

    it('reads again at once for a push that lands while a read is on its way', async () => {
      vi.useFakeTimers();
      let answer!: (status: { status: string }) => void;
      const getStatus = vi.fn(() => new Promise<{ status: string }>((resolve) => { answer = resolve; }));
      const polling = pollGenerationStatus(getStatus, { random: () => 0, wake: subscribeToGenerationSettledPush, maxDelayMs: GENERATION_POLL_MAX_DELAY_MS });
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(1);

      announceGenerationSettledPush();
      answer({ status: 'processing' });
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(2);
      answer({ status: 'succeeded' });
      await expect(polling).resolves.toEqual({ status: 'succeeded' });
    });

    it('wakes for a completion push and for the app coming back to the front, and stops listening to both', () => {
      const appActive = new Set<() => void>();
      const subscribeToAppActive = (onActive: () => void) => {
        appActive.add(onActive);
        return () => { appActive.delete(onActive); };
      };
      const onWake = vi.fn();
      const stop = wakeOnGenerationSettledOrAppActive(subscribeToAppActive)(onWake);
      announceGenerationSettledPush();
      appActive.forEach((listener) => listener());
      expect(onWake).toHaveBeenCalledTimes(2);

      stop();
      announceGenerationSettledPush();
      expect(appActive.size).toBe(0);
      expect(onWake).toHaveBeenCalledTimes(2);
    });

    it('reads at once when a completion push arrives, and goes on waiting when the run is still working', async () => {
      vi.useFakeTimers();
      const statuses = [{ status: 'processing' }, { status: 'processing' }, { status: 'succeeded', outputs: ['done.png'] }];
      const getStatus = vi.fn(async () => statuses.shift()!);
      const polling = pollGenerationStatus(getStatus, { random: () => 0, wake: subscribeToGenerationSettledPush });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(getStatus).toHaveBeenCalledTimes(1);
      // Another run's push: this one is read, still works, and the next wait starts.
      announceGenerationSettledPush();
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(getStatus).toHaveBeenCalledTimes(2);
      announceGenerationSettledPush();
      await expect(polling).resolves.toEqual({ status: 'succeeded', outputs: ['done.png'] });
      expect(getStatus).toHaveBeenCalledTimes(3);
      // The finished poll listens no longer.
      announceGenerationSettledPush();
      await vi.advanceTimersByTimeAsync(0);
      expect(getStatus).toHaveBeenCalledTimes(3);
    });

    it('stops listening when it is cancelled', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const getStatus = vi.fn(async () => ({ status: 'processing' }));
      const polling = pollGenerationStatus(getStatus, { random: () => 0, wake: subscribeToGenerationSettledPush, signal: controller.signal });
      const cancelled = expect(polling).rejects.toThrow('Generation status check cancelled.');
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await cancelled;
      announceGenerationSettledPush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getStatus).toHaveBeenCalledTimes(1);
    });

    it('lets a poll wait 30 s only where the run\'s completion push can reach this phone', () => {
      const registered = { status: 'registered', expoPushToken: 'ExponentPushToken[1]' } as const;
      const on = { pushEnabled: true, generationEnabled: true };
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: on })).toBe(GENERATION_POLL_MAX_DELAY_MS);
      // Not read on this launch: run alerts may be off on the account (turned
      // off on the web or another phone), so no push is counted on (review follow-up 3).
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: undefined })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: null })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: {} })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);

      expect(generationPollMaxDelayMs({ isGuest: true, devicePush: registered, preferences: on })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: { status: 'denied' }, preferences: on })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: undefined, preferences: on })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: { ...on, pushEnabled: false } })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
      expect(generationPollMaxDelayMs({ isGuest: false, devicePush: registered, preferences: { ...on, generationEnabled: false } })).toBe(GENERATION_POLL_UNWOKEN_MAX_DELAY_MS);
    });

    it('reads its longest wait again before each wait, so preferences read meanwhile count', async () => {
      let cap = GENERATION_POLL_UNWOKEN_MAX_DELAY_MS;
      // 8, 12, 15 (the cap unknown), then 27 and 30 once run alerts are known to be on.
      const times = await readTimes({
        maxDelayMs: () => {
          const current = cap;
          if (Date.now() >= 20_000 + startedAtForCap) cap = GENERATION_POLL_MAX_DELAY_MS;
          return current;
        },
      }, 96_000);
      expect(times).toEqual([0, 8, 20, 35, 62, 92]);
    });

    it('knows a completion push by its type', () => {
      expect(isGenerationSettledPush('generation_succeeded')).toBe(true);
      expect(isGenerationSettledPush('generation_failed')).toBe(true);
      expect(isGenerationSettledPush('new_follower')).toBe(false);
      expect(isGenerationSettledPush(null)).toBe(false);
    });
  });
});

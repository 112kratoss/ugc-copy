import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGenerationOutput, getPollDelayMs, isGenerationFinished, pollGenerationStatus } from '../lib/generation';

describe('generation polling helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recognizes terminal provider states', () => {
    expect(isGenerationFinished('succeeded')).toBe(true);
    expect(isGenerationFinished('failed')).toBe(true);
    expect(isGenerationFinished('processing')).toBe(false);
  });

  it('prefers the first output URL from a multi-output response', () => {
    expect(getGenerationOutput({ status: 'succeeded', output: 'fallback.png', outputs: ['first.png', 'second.png'] })).toBe('first.png');
    expect(getGenerationOutput({ status: 'succeeded', output: 'single.mp4' })).toBe('single.mp4');
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
});

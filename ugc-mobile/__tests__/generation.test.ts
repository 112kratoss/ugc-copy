import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGenerationOutput, isGenerationFinished, pollGenerationStatus } from '../lib/generation';

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
      intervalMs: 25,
      timeoutMs: 1000,
      onTick,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({ status: 'succeeded', outputs: ['done.png'] });
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

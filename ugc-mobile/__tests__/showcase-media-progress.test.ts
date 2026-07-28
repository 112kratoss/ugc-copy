import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createShowcaseMediaProgressTracker,
  reportShowcaseMediaProgress,
  resetShowcaseMediaProgressSinkForTests,
  setShowcaseMediaProgressSink,
} from '@/lib/showcase-media-progress';

afterEach(() => {
  resetShowcaseMediaProgressSinkForTests();
});

describe('showcase media progress tracker', () => {
  it('keeps the maximum position across loop wraparounds', () => {
    const tracker = createShowcaseMediaProgressTracker();
    tracker.record(0.6, 14_000);
    tracker.record(0.05, 14_000);
    expect(tracker.maxProgress).toBe(0.6);
    expect(tracker.takeFlush()).toEqual({ progress: 0.6, durationMs: 14_000 });
  });

  it('requests a flush exactly when an unflushed milestone is crossed', () => {
    const tracker = createShowcaseMediaProgressTracker();
    expect(tracker.record(0.1)).toBe(false);
    expect(tracker.record(0.26)).toBe(true);
    tracker.takeFlush();
    expect(tracker.record(0.3)).toBe(false);
    expect(tracker.record(0.52)).toBe(true);
    expect(tracker.record(0.98)).toBe(true);
  });

  it('does not re-flush an unchanged maximum', () => {
    const tracker = createShowcaseMediaProgressTracker();
    tracker.record(0.4, 10_000);
    expect(tracker.takeFlush()).toEqual({ progress: 0.4, durationMs: 10_000 });
    expect(tracker.takeFlush()).toBeNull();
    tracker.record(0.35);
    expect(tracker.takeFlush()).toBeNull();
    tracker.record(0.45);
    expect(tracker.takeFlush()).toEqual({ progress: 0.45, durationMs: 10_000 });
  });

  it('never flushes when nothing played and clamps malformed samples', () => {
    const tracker = createShowcaseMediaProgressTracker();
    expect(tracker.takeFlush()).toBeNull();
    tracker.record(Number.NaN, Number.POSITIVE_INFINITY);
    expect(tracker.takeFlush()).toBeNull();
    tracker.record(4.2, 9_000);
    expect(tracker.takeFlush()).toEqual({ progress: 1, durationMs: 9_000 });
  });
});

describe('showcase media progress sink', () => {
  it('routes reports to the registered sink and stops after unregistering', () => {
    const sink = vi.fn();
    setShowcaseMediaProgressSink(sink);
    reportShowcaseMediaProgress(0.5, 12_000);
    expect(sink).toHaveBeenCalledWith(0.5, 12_000);

    setShowcaseMediaProgressSink(null);
    reportShowcaseMediaProgress(0.9, 12_000);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

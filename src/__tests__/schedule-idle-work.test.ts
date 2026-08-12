import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  scheduleIdleDebouncedWork,
  scheduleIdleWork,
} from '@/lib/schedule-idle-work';

describe('idle work scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps ordinary fallback idle work responsive', () => {
    const callback = vi.fn();
    scheduleIdleWork(callback, 2_000);

    vi.advanceTimersByTime(79);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('waits for the full quiet period before entering idle work', () => {
    const callback = vi.fn();
    scheduleIdleDebouncedWork(callback, 1_000, 2_000);

    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(79);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels both the quiet timer and queued idle work', () => {
    const callback = vi.fn();
    const firstCancel = scheduleIdleDebouncedWork(callback, 1_000);
    firstCancel();
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();

    const secondCancel = scheduleIdleDebouncedWork(callback, 1_000);
    vi.advanceTimersByTime(1_000);
    secondCancel();
    vi.runAllTimers();
    expect(callback).not.toHaveBeenCalled();
  });
});

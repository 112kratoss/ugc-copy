import { describe, expect, it } from 'vitest';

import {
  MEDIA_AUTO_RETRY_BASE_DELAY_MS,
  MEDIA_AUTO_RETRY_MAX_DELAY_MS,
  classifyImageStall,
  createMediaRecoveryBudget,
  mediaAutoRetryDelayMs,
} from '../lib/media-recovery';

describe('media recovery budget', () => {
  it('hands out a limited number of slots and takes each back exactly once', () => {
    const budget = createMediaRecoveryBudget(2);
    const first = budget.tryAcquire();
    const second = budget.tryAcquire();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(budget.tryAcquire()).toBeNull();

    first?.release();
    first?.release();
    expect(budget.activeCount()).toBe(1);

    const third = budget.tryAcquire();
    expect(third).not.toBeNull();
    second?.release();
    third?.release();
    expect(budget.activeCount()).toBe(0);
  });
});

describe('classifyImageStall', () => {
  it('says how far a stalled image got', () => {
    expect(classifyImageStall({ progressed: false, loaded: false })).toBe('no-response');
    expect(classifyImageStall({ progressed: true, loaded: false })).toBe('downloading');
    expect(classifyImageStall({ progressed: true, loaded: true })).toBe('decoded-not-displayed');
  });
});

describe('mediaAutoRetryDelayMs', () => {
  it('waits longer after each silent retry, up to a cap, with some jitter', () => {
    const noJitter = () => 0;
    expect(mediaAutoRetryDelayMs(0, noJitter)).toBe(MEDIA_AUTO_RETRY_BASE_DELAY_MS);
    expect(mediaAutoRetryDelayMs(1, noJitter)).toBe(MEDIA_AUTO_RETRY_BASE_DELAY_MS * 2);
    expect(mediaAutoRetryDelayMs(2, noJitter)).toBe(MEDIA_AUTO_RETRY_BASE_DELAY_MS * 4);
    expect(mediaAutoRetryDelayMs(3, noJitter)).toBe(MEDIA_AUTO_RETRY_MAX_DELAY_MS);
    expect(mediaAutoRetryDelayMs(12, noJitter)).toBe(MEDIA_AUTO_RETRY_MAX_DELAY_MS);
    expect(mediaAutoRetryDelayMs(-1, noJitter)).toBe(MEDIA_AUTO_RETRY_BASE_DELAY_MS);
    expect(mediaAutoRetryDelayMs(0, () => 1)).toBe(MEDIA_AUTO_RETRY_BASE_DELAY_MS * 1.25);
    // The cap bounds the base; jitter still spreads images latched together.
    expect(mediaAutoRetryDelayMs(5, () => 1)).toBe(MEDIA_AUTO_RETRY_MAX_DELAY_MS * 1.25);
  });
});

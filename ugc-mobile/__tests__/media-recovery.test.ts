import { describe, expect, it } from 'vitest';

import { classifyImageStall, createMediaRecoveryBudget } from '../lib/media-recovery';

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

import { describe, expect, it } from 'vitest';

import {
  formatDurationShort,
  formatElapsedClock,
  getGenerationTimingSummaryLabel,
  normalizeMarketGenerationTiming,
  normalizeVeoGenerationTiming,
} from '@/lib/generation-timing';

describe('generation timing', () => {
  it.each([
    ['waiting', 'waiting', 'waiting', 'Waiting for provider'],
    ['queuing', 'waiting', 'queuing', 'Queued at provider'],
    ['generating', 'processing', 'generating', 'Generating video'],
    ['success', 'succeeded', 'success', 'Video ready'],
    ['fail', 'failed', 'fail', 'Video failed'],
  ] as const)(
    'normalizes market state %s',
    (state, appStatus, providerState, phaseLabel) => {
      const timing = normalizeMarketGenerationTiming({
        kind: 'video',
        task: {
          state,
          createTime: '2026-04-15T10:00:00.000Z',
          updateTime: '2026-04-15T10:00:05.000Z',
          completeTime: state === 'success' || state === 'fail' ? '2026-04-15T10:00:42.000Z' : null,
          costTime: state === 'success' ? 42000 : null,
        },
        nowMs: Date.parse('2026-04-15T10:00:20.000Z'),
      });

      expect(timing).toMatchObject({
        appStatus,
        providerState,
        phaseLabel,
        startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
      });
    }
  );

  it('falls back to the local start time when provider timestamps are missing', () => {
    const timing = normalizeMarketGenerationTiming({
      kind: 'motion',
      task: {
        state: 'generating',
      },
      fallbackStartedAtMs: 1_000,
      nowMs: 5_000,
    });

    expect(timing.startedAtMs).toBe(1_000);
    expect(timing.elapsedMs).toBe(4_000);
    expect(timing.completedInMs).toBeNull();
    expect(getGenerationTimingSummaryLabel(timing, 5_000)).toBe('Elapsed 00:04');
  });

  it.each([
    [0, 'processing', 'generating'],
    [1, 'succeeded', 'success'],
    [2, 'failed', 'fail'],
    [3, 'failed', 'fail'],
  ] as const)('normalizes veo successFlag %s', (successFlag, appStatus, providerState) => {
    const timing = normalizeVeoGenerationTiming({
      kind: 'video',
      task: {
        successFlag,
        createTime: '2026-04-15 10:00:00',
        completeTime: '2026-04-15 10:01:03',
      },
    });

    expect(timing.appStatus).toBe(appStatus);
    expect(timing.providerState).toBe(providerState);
    expect(timing.startedAtMs).toBe(Date.parse('2026-04-15T10:00:00.000Z'));
    if (successFlag !== 0) {
      expect(timing.completedInMs).toBe(63_000);
    }
  });

  it('formats elapsed and completed summaries for the UI', () => {
    expect(formatElapsedClock(125_000)).toBe('02:05');
    expect(formatDurationShort(42_000)).toBe('42s');

    const succeededTiming = normalizeMarketGenerationTiming({
      kind: 'image',
      task: {
        state: 'success',
        createTime: '2026-04-15T10:00:00.000Z',
        completeTime: '2026-04-15T10:00:42.000Z',
        costTime: 42_000,
      },
    });

    expect(getGenerationTimingSummaryLabel(succeededTiming)).toBe('Completed in 42s');
  });
});

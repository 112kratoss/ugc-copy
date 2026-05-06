import { describe, expect, it } from 'vitest';

import {
  estimateGenerationDurationMs,
  formatDurationShort,
  formatElapsedClock,
  getGenerationTimingCountdownLabel,
  getGenerationTimingProgressPercent,
  getGenerationTimingSummaryLabel,
  normalizeMarketGenerationTiming,
  normalizeVeoGenerationTiming,
  withGenerationTimingEstimate,
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

  it('estimates remaining time for in-flight image generations', () => {
    const estimatedTotalMs = estimateGenerationDurationMs({
      kind: 'image',
      model: 'gpt-image-2',
      resolution: '2K',
      referenceCount: 2,
    });

    expect(estimatedTotalMs).toBe(175_000);

    const timing = withGenerationTimingEstimate(
      normalizeMarketGenerationTiming({
        kind: 'image',
        task: {
          state: 'waiting',
          createTime: '2026-04-15T10:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-15T10:00:40.000Z'),
      }),
      estimatedTotalMs
    );

    expect(getGenerationTimingCountdownLabel(timing, Date.parse('2026-04-15T10:00:40.000Z'))).toBe('Est. 02:15 left');
    expect(getGenerationTimingSummaryLabel(timing, Date.parse('2026-04-15T10:00:40.000Z'))).toBe('Elapsed 00:40');
    expect(getGenerationTimingProgressPercent(timing, Date.parse('2026-04-15T10:00:40.000Z'))).toBeCloseTo(22.857, 2);
  });

  it('switches countdown copy when an estimate is exceeded', () => {
    const timing = withGenerationTimingEstimate(
      normalizeMarketGenerationTiming({
        kind: 'image',
        task: {
          state: 'waiting',
          createTime: '2026-04-15T10:00:00.000Z',
        },
        nowMs: Date.parse('2026-04-15T10:03:10.000Z'),
      }),
      120_000
    );

    expect(getGenerationTimingCountdownLabel(timing, Date.parse('2026-04-15T10:03:10.000Z'))).toBe('Taking longer than usual');
    expect(getGenerationTimingProgressPercent(timing, Date.parse('2026-04-15T10:03:10.000Z'))).toBe(96);
  });

  it('estimates video generation duration from model settings', () => {
    expect(estimateGenerationDurationMs({
      kind: 'video',
      model: 'kling-3.0-video',
      mode: 'pro',
      durationSeconds: 10,
      isMultiShot: true,
      shotCount: 3,
      hasSound: true,
      referenceCount: 2,
    })).toBe(505_000);

    expect(estimateGenerationDurationMs({
      kind: 'video',
      model: 'seedance-2-fast',
      resolution: '720p',
      durationSeconds: 15,
      referenceCount: 3,
      hasReferenceVideo: true,
    })).toBe(260_000);

    expect(estimateGenerationDurationMs({
      kind: 'video',
      model: 'veo-3.1',
      mode: 'veo3',
      durationSeconds: 8,
    })).toBe(300_000);
  });

  it('estimates motion generation duration from model, duration, and resolution', () => {
    expect(estimateGenerationDurationMs({
      kind: 'motion',
      model: 'kling-3.0',
      resolution: '1080p',
      durationSeconds: 12,
    })).toBe(420_000);

    expect(estimateGenerationDurationMs({
      kind: 'motion',
      model: 'kling-2.6',
      resolution: '720p',
      durationSeconds: 10,
    })).toBe(260_000);
  });
});

import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  generationQueueAhead,
  generationWaitCountdownLabel,
  generationWaitDetail,
  generationWaitPhase,
  generationWaitProgressPercent,
  generationWaitTitle,
  readGenerationWaitTiming,
  type GenerationWaitTiming,
} from '../lib/generation-wait';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');

/** A run the server says started `elapsedMs` ago and usually takes `estimatedTotalMs`. */
function running(elapsedMs: number, estimatedTotalMs: number | null = 60_000): GenerationWaitTiming {
  return { appStatus: 'processing', startedAtMs: NOW - elapsedMs, estimatedTotalMs, completedInMs: null };
}

describe('reading the status response’s timing', () => {
  it('takes the fields the server’s GenerationTiming sends', () => {
    expect(readGenerationWaitTiming({
      appStatus: 'processing',
      providerState: 'generating',
      phaseLabel: 'Generating your image',
      startedAtMs: NOW - 15_000,
      updatedAtMs: null,
      completedAtMs: null,
      elapsedMs: 15_000,
      completedInMs: null,
      estimatedTotalMs: 120_000,
    })).toEqual({ appStatus: 'processing', startedAtMs: NOW - 15_000, estimatedTotalMs: 120_000, completedInMs: null });
    // A run that settled in no time at all still settled.
    expect(readGenerationWaitTiming({ appStatus: 'succeeded', startedAtMs: NOW, completedInMs: 0 })?.completedInMs).toBe(0);
  });

  it('reads a malformed payload as no estimate, never as a wrong one', () => {
    for (const value of [undefined, null, 'processing', 42, [NOW, 60_000]]) {
      expect(readGenerationWaitTiming(value)).toBeNull();
    }
    expect(readGenerationWaitTiming({
      appStatus: 7,
      startedAtMs: '2026-10-14T10:00:00Z',
      estimatedTotalMs: 0,
      completedInMs: -5,
    })).toEqual({ appStatus: null, startedAtMs: null, estimatedTotalMs: null, completedInMs: null });
    expect(readGenerationWaitTiming({ startedAtMs: Number.NaN, estimatedTotalMs: Number.POSITIVE_INFINITY }))
      .toEqual({ appStatus: null, startedAtMs: null, estimatedTotalMs: null, completedInMs: null });
  });
});

describe('the countdown', () => {
  it('counts down the estimate as the web does', () => {
    expect(generationWaitCountdownLabel(running(15_000), NOW)).toBe('Est. 0:45 left');
    expect(generationWaitCountdownLabel(running(0, 125_000), NOW)).toBe('Est. 2:05 left');
    // Rounded up, as the web rounds it, so the last second reads 0:01 rather than 0:00.
    expect(generationWaitCountdownLabel(running(15_400), NOW)).toBe('Est. 0:45 left');
    expect(generationWaitCountdownLabel(running(59_999), NOW)).toBe('Est. 0:01 left');
  });

  it('says so once the estimate has passed, rather than counting below zero', () => {
    expect(generationWaitCountdownLabel(running(60_000), NOW)).toBe('Taking longer than usual');
    expect(generationWaitCountdownLabel(running(600_000), NOW)).toBe('Taking longer than usual');
  });

  it('holds the whole estimate when the start reads as later than now', () => {
    // The phone's clock and the server's can disagree by a little.
    expect(generationWaitCountdownLabel(running(-3_000), NOW)).toBe('Est. 1:00 left');
  });

  it('says nothing without an estimate, a start, a clock, or once the run has settled', () => {
    expect(generationWaitCountdownLabel(null, NOW)).toBeNull();
    expect(generationWaitCountdownLabel(running(15_000, null), NOW)).toBeNull();
    expect(generationWaitCountdownLabel({ ...running(15_000), startedAtMs: null }, NOW)).toBeNull();
    expect(generationWaitCountdownLabel(running(15_000), null)).toBeNull();
    expect(generationWaitCountdownLabel({ ...running(15_000), appStatus: 'succeeded' }, NOW)).toBeNull();
    expect(generationWaitCountdownLabel({ ...running(15_000), appStatus: 'failed' }, NOW)).toBeNull();
    expect(generationWaitCountdownLabel({ ...running(15_000), completedInMs: 14_000 }, NOW)).toBeNull();
  });
});

describe('the bar', () => {
  it('fills with the share of the estimate that has passed', () => {
    expect(generationWaitProgressPercent(running(15_000), NOW)).toBe(25);
    expect(generationWaitProgressPercent(running(45_000), NOW)).toBe(75);
  });

  it('shows some fill from the start and never reads as done before the model has answered', () => {
    expect(generationWaitProgressPercent(running(0), NOW)).toBe(8);
    expect(generationWaitProgressPercent(running(-3_000), NOW)).toBe(8);
    expect(generationWaitProgressPercent(running(59_000), NOW)).toBe(96);
    expect(generationWaitProgressPercent(running(600_000), NOW)).toBe(96);
  });

  it('is full once the run has finished, and absent without an estimate, a start or a clock', () => {
    expect(generationWaitProgressPercent({ ...running(15_000), appStatus: 'succeeded' }, NOW)).toBe(100);
    expect(generationWaitProgressPercent({ ...running(15_000, null), completedInMs: 14_000 }, NOW)).toBe(100);
    expect(generationWaitProgressPercent(null, NOW)).toBeNull();
    expect(generationWaitProgressPercent(running(15_000, null), NOW)).toBeNull();
    expect(generationWaitProgressPercent({ ...running(15_000), startedAtMs: null }, NOW)).toBeNull();
    expect(generationWaitProgressPercent(running(15_000), null)).toBeNull();
  });
});

describe('a run waiting in the server’s queue', () => {
  const queued = mobileApiContract.endpoints.startGeneration.queued.status;

  it('is told apart from a run the model has: only `waiting` with `queued` is in line', () => {
    expect(generationWaitPhase('waiting', true)).toBe('in_line');
    expect(generationWaitPhase('waiting')).toBe('queued');
    expect(generationWaitPhase('waiting', false)).toBe('queued');
    // Sent since the last read: the flag of an older answer never outlasts the status.
    expect(generationWaitPhase('processing', true)).toBe('running');
    // Only the server's own `true` counts.
    for (const value of ['true', 1, {}, null]) {
      expect(generationWaitPhase('waiting', value)).toBe('queued');
    }
  });

  it('counts the starts ahead of it from its place', () => {
    expect(generationQueueAhead(4)).toBe(3);
    expect(generationQueueAhead(1)).toBe(0);
    for (const value of [undefined, null, '4', 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(generationQueueAhead(value)).toBeNull();
    }
  });

  it('says its place, and that it is next, in the words the server sends the web', () => {
    expect(generationWaitTitle('in_line', 'image', 3)).toBe('Queued · 3 ahead of you');
    expect(generationWaitTitle('in_line', 'video', 0)).toBe('Queued · starting soon');
    // A place the server did not send is no count, never a wrong one.
    expect(generationWaitTitle('in_line', 'image', null)).toBe('Queued');
    expect(generationWaitTitle('in_line', 'image')).toBe('Queued');
  });

  it('reads the contract’s queued status as the server words it', () => {
    const phase = generationWaitPhase(queued.status, queued.queued);
    expect(phase).toBe('in_line');
    expect(generationWaitTitle(phase, 'image', generationQueueAhead(queued.queuePosition)))
      .toBe(queued.timing.phaseLabel);
    // No estimate and no start to count down from: no bar, no countdown.
    const timing = readGenerationWaitTiming(queued.timing);
    expect(generationWaitCountdownLabel(timing, NOW)).toBeNull();
    expect(generationWaitProgressPercent(timing, NOW)).toBeNull();
  });

  it('says it needs nothing from the creator, and never that it is running', () => {
    expect(generationWaitDetail('in_line', null)).toBe('It starts by itself when its turn comes.');
    expect(generationWaitDetail('in_line', 75)).toBe('It starts by itself when its turn comes. Waiting for 1:15.');
    expect(generationWaitDetail('in_line', 75)).not.toContain('Running');
  });
});

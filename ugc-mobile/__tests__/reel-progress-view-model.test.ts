import { describe, expect, it } from 'vitest';

import { MIN_HIT_TARGET_PT } from '@/lib/hit-target';
import {
  REEL_CAPTION_BOTTOM_LIFT,
  REEL_PROGRESS_LINE_LIFT,
  REEL_SEEK_END_GUARD_SECONDS,
  createReelWatchReach,
  formatReelClock,
  reelAccessibilityStepSeconds,
  reelProgressAccessibilityText,
  reelProgressFraction,
  reelProgressFrame,
  reelProgressNeedsResync,
  reelProgressRunPosition,
  reelScrubDecision,
  reelScrubFraction,
  reelScrubLabel,
  reelSeekSeconds,
  spokenReelClock,
} from '@/lib/reel-progress-view-model';

describe('reelProgressFrame', () => {
  it('runs a 44pt touch area up to the caption and down into the inset', () => {
    const frame = reelProgressFrame(34);
    expect(frame.height).toBe(MIN_HIT_TARGET_PT);
    expect(frame.bottom + frame.height).toBe(34 + REEL_CAPTION_BOTTOM_LIFT);
    expect(frame.bottom).toBe(14);
    // The line sits just above the inset, inside the area.
    expect(frame.bottom + frame.lineCenter).toBe(34 + REEL_PROGRESS_LINE_LIFT);
    expect(frame.lineCenter).toBeGreaterThan(0);
    expect(frame.lineCenter).toBeLessThan(frame.height);
  });

  it('keeps its 44pt from the bottom edge where there is no inset', () => {
    const frame = reelProgressFrame(0);
    expect(frame).toEqual({ bottom: 0, height: MIN_HIT_TARGET_PT, lineCenter: REEL_PROGRESS_LINE_LIFT });
  });

  it('reads a broken inset as none', () => {
    expect(reelProgressFrame(Number.NaN)).toEqual(reelProgressFrame(0));
    expect(reelProgressFrame(-12)).toEqual(reelProgressFrame(0));
  });
});

describe('reelScrubDecision', () => {
  it('waits while the finger has barely moved', () => {
    expect(reelScrubDecision(0, 0)).toBe('wait');
    expect(reelScrubDecision(5, 3)).toBe('wait');
    expect(reelScrubDecision(-7, 2)).toBe('wait');
  });

  it('scrubs a sideways drag in either direction', () => {
    expect(reelScrubDecision(8, 2)).toBe('scrub');
    expect(reelScrubDecision(-12, 5)).toBe('scrub');
  });

  it('hands a swipe up or down to the reel, even one that starts on the bar', () => {
    expect(reelScrubDecision(2, -10)).toBe('pass');
    expect(reelScrubDecision(4, 14)).toBe('pass');
  });

  it('gives a diagonal to whichever way it moved most', () => {
    expect(reelScrubDecision(12, 10)).toBe('scrub');
    expect(reelScrubDecision(10, 12)).toBe('pass');
  });
});

describe('fractions and seeks', () => {
  it('clamps progress to the clip', () => {
    expect(reelProgressFraction(3, 12)).toBe(0.25);
    expect(reelProgressFraction(-1, 12)).toBe(0);
    expect(reelProgressFraction(13, 12)).toBe(1);
    expect(reelProgressFraction(3, 0)).toBe(0);
    expect(reelProgressFraction(Number.NaN, 12)).toBe(0);
  });

  it('clamps a finger to the line', () => {
    expect(reelScrubFraction(85, 340)).toBe(0.25);
    expect(reelScrubFraction(-20, 340)).toBe(0);
    expect(reelScrubFraction(400, 340)).toBe(1);
    expect(reelScrubFraction(40, 0)).toBe(0);
  });

  it('never seeks a looping clip onto its end, where it would start over', () => {
    expect(reelSeekSeconds(0.5, 12)).toBe(6);
    expect(reelSeekSeconds(1, 12)).toBe(12 - REEL_SEEK_END_GUARD_SECONDS);
    expect(reelSeekSeconds(-0.2, 12)).toBe(0);
    expect(reelSeekSeconds(0.5, 0)).toBe(0);
    expect(reelSeekSeconds(1, 0.05)).toBe(0);
  });
});

describe('following the player', () => {
  const run = { from: 0.25, startedAt: 1_000, durationMs: 9_000 };

  it('moves a run linearly to the end and holds it there', () => {
    expect(reelProgressRunPosition(run, 1_000)).toBe(0.25);
    expect(reelProgressRunPosition(run, 5_500)).toBeCloseTo(0.625);
    expect(reelProgressRunPosition(run, 10_000)).toBe(1);
    expect(reelProgressRunPosition(run, 20_000)).toBe(1);
    expect(reelProgressRunPosition({ from: 0.9, startedAt: 0, durationMs: 0 }, 0)).toBe(1);
  });

  it('leaves a run alone while it agrees with the player', () => {
    // 12 s clip: at 5.5 s the run is at 0.625, and 0.62 is 0.06 s away.
    expect(reelProgressNeedsResync(run, 5_500, 0.62, 12)).toBe(false);
  });

  it('sets the line back when the player stalled, looped or was moved', () => {
    expect(reelProgressNeedsResync(run, 5_500, 0.5, 12)).toBe(true);
    // The clip started over while the run sat at its end.
    expect(reelProgressNeedsResync(run, 10_200, 0.02, 12)).toBe(true);
    expect(reelProgressNeedsResync(null, 0, 0.3, 12)).toBe(true);
  });
});

describe('clock text', () => {
  it('reads minutes and seconds, with hours once there are any', () => {
    expect(formatReelClock(4.9)).toBe('0:04');
    expect(formatReelClock(65)).toBe('1:05');
    expect(formatReelClock(3723)).toBe('1:02:03');
    expect(formatReelClock(-3)).toBe('0:00');
    expect(formatReelClock(Number.NaN)).toBe('0:00');
  });

  it('rounds the length and floors the position, as players do', () => {
    expect(formatReelClock(12.97, 'round')).toBe('0:13');
    expect(reelScrubLabel(4.6, 12.97)).toBe('0:04 / 0:13');
  });

  it('says a length the way a screen reader should', () => {
    expect(spokenReelClock(0)).toBe('0 seconds');
    expect(spokenReelClock(1)).toBe('1 second');
    expect(spokenReelClock(4.4)).toBe('4 seconds');
    expect(spokenReelClock(60)).toBe('1 minute');
    expect(spokenReelClock(65)).toBe('1 minute 5 seconds');
    expect(spokenReelClock(3661)).toBe('1 hour 1 minute 1 second');
    expect(reelProgressAccessibilityText(4, 12.97)).toBe('4 seconds of 13 seconds');
  });

  it('steps a screen reader a tenth of the clip, and at least a second', () => {
    expect(reelAccessibilityStepSeconds(8)).toBe(1);
    expect(reelAccessibilityStepSeconds(60)).toBe(6);
    expect(reelAccessibilityStepSeconds(0)).toBe(0);
  });
});

describe('createReelWatchReach', () => {
  const play = (reach: ReturnType<typeof createReelWatchReach>, from: number, to: number) => {
    let last = 0;
    for (let at = from; at <= to + 1e-9; at += 0.25) last = reach.sample(Number(at.toFixed(2)));
    return last;
  };

  it('is the furthest position while the reader only watches', () => {
    const reach = createReelWatchReach();
    expect(play(reach, 0, 6)).toBe(6);
  });

  it('keeps what was reached through a loop starting over', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 9.75);
    expect(reach.sample(0.1)).toBe(9.75);
    expect(play(reach, 0.25, 4)).toBe(9.75);
  });

  it('lets the first report stand, as a clip taken over part-way in starts there', () => {
    const reach = createReelWatchReach();
    expect(reach.sample(3)).toBe(3);
    expect(play(reach, 3.25, 5)).toBe(5);
  });

  it('does not count a clip the reader scrubbed forward as watched', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 3);
    reach.noteSeek();
    expect(reach.sample(10.8)).toBe(3);
    expect(play(reach, 11, 11.9)).toBe(3);
  });

  it('counts again once playing carries a clip past what was reached', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 6);
    reach.noteSeek();
    expect(reach.sample(2)).toBe(6);
    expect(play(reach, 2.25, 8)).toBe(8);
  });

  it('catches a forward jump nobody announced', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 2);
    expect(reach.sample(9)).toBe(2);
    expect(play(reach, 9.25, 11)).toBe(2);
  });

  it('does not count a report from before the seek that arrives after it', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 2);
    reach.noteSeek();
    // A report sent just before the seek took effect, then the clip at its new place.
    expect(reach.sample(2.25)).toBe(2);
    expect(reach.sample(9)).toBe(2);
    expect(play(reach, 9.25, 10)).toBe(2);
  });

  it('starts from nothing when the clip was moved before its first report', () => {
    const reach = createReelWatchReach();
    reach.noteSeek();
    expect(reach.sample(7)).toBe(0);
    expect(play(reach, 7.25, 8)).toBe(0);
  });

  it('ignores a broken report', () => {
    const reach = createReelWatchReach();
    play(reach, 0, 1);
    expect(reach.sample(Number.NaN)).toBe(1);
    expect(reach.sample(-1)).toBe(1);
  });
});

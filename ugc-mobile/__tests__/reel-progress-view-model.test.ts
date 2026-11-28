import { describe, expect, it } from 'vitest';

import { MIN_HIT_TARGET_PT, verticalHitSlop } from '@/lib/hit-target';
import {
  REEL_CAPTION_BOTTOM_LIFT,
  REEL_CAPTION_SLOP_BELOW,
  REEL_CREATOR_ROW_HEIGHT,
  REEL_FOLLOW_PILL_HIT_SLOP,
  REEL_PROGRESS_END_SLOP,
  REEL_PROGRESS_LINE_LIFT,
  REEL_PROGRESS_SIDE_INSET,
  REEL_SEEK_END_GUARD_SECONDS,
  createReelWatchReach,
  createReelWatchVisit,
  formatReelClock,
  reelAccessibilityStepSeconds,
  reelCaptionBottom,
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

describe('the caption and the bar under it', () => {
  it('reaches below the caption by the most any of its rows reaches', () => {
    expect(REEL_CAPTION_SLOP_BELOW).toBe(Math.max(REEL_FOLLOW_PILL_HIT_SLOP, verticalHitSlop(REEL_CREATOR_ROW_HEIGHT).bottom));
  });

  it('keeps the caption where it was on a phone with a home indicator or a navigation bar', () => {
    expect(reelCaptionBottom(34)).toBe(34 + REEL_CAPTION_BOTTOM_LIFT);
    expect(reelCaptionBottom(48)).toBe(48 + REEL_CAPTION_BOTTOM_LIFT);
  });

  it('lifts the caption on a phone with no inset, so the bar fits under it', () => {
    expect(reelCaptionBottom(0)).toBe(MIN_HIT_TARGET_PT + REEL_CAPTION_SLOP_BELOW);
    expect(reelCaptionBottom(Number.NaN)).toBe(reelCaptionBottom(0));
    expect(reelCaptionBottom(-12)).toBe(reelCaptionBottom(0));
  });

  for (const inset of [0, 20, 34, 48, 80]) {
    it(`takes no touch from the caption with a ${inset}pt inset`, () => {
      const frame = reelProgressFrame(inset);
      expect(frame.height).toBe(MIN_HIT_TARGET_PT);
      expect(frame.bottom).toBeGreaterThanOrEqual(0);
      // The touch area stops below the lowest reach of the caption's own touch areas.
      expect(frame.bottom + frame.height).toBeLessThanOrEqual(reelCaptionBottom(inset) - REEL_CAPTION_SLOP_BELOW);
      // The line is inside its touch area.
      expect(frame.lineCenter).toBeGreaterThan(0);
      expect(frame.lineCenter).toBeLessThan(frame.height);
    });
  }

  it('draws the line just above a home indicator', () => {
    const frame = reelProgressFrame(34);
    expect(frame.bottom + frame.lineCenter).toBe(34 + REEL_PROGRESS_LINE_LIFT);
  });

  it('keeps the touch area to the line and its ends, clear of the screen edges', () => {
    const frame = reelProgressFrame(34);
    expect(frame.side).toBe(REEL_PROGRESS_SIDE_INSET - REEL_PROGRESS_END_SLOP);
    expect(frame.side).toBeGreaterThan(0);
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

/** Plays from `from` to `to` in quarter-second reports, the clock moving with the clip. */
function play(reach: ReturnType<typeof createReelWatchReach>, clock: { now: number }, from: number, to: number) {
  let last = 0;
  for (let at = from; at <= to + 1e-9; at += 0.25) {
    last = reach.sample(Number(at.toFixed(2)), clock.now);
    clock.now += 250;
  }
  return last;
}

describe('createReelWatchReach', () => {
  it('is the furthest position while the reader only watches', () => {
    const clock = { now: 0 };
    expect(play(createReelWatchReach(), clock, 0, 6)).toBe(6);
  });

  it('keeps what was reached through a loop starting over', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 9.75);
    expect(reach.sample(0.1, clock.now)).toBe(9.75);
    expect(play(reach, clock, 0.25, 4)).toBe(9.75);
  });

  it('lets the first report stand, as a clip taken over part-way in starts there', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    expect(reach.sample(3, clock.now)).toBe(3);
    clock.now += 250;
    expect(play(reach, clock, 3.25, 5)).toBe(5);
  });

  it('does not count a clip the reader scrubbed forward as watched', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 3);
    reach.noteSeek();
    expect(reach.sample(10.8, clock.now)).toBe(3);
    clock.now += 250;
    expect(play(reach, clock, 11, 11.9)).toBe(3);
  });

  it('counts again once playing carries a clip past what was reached', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 6);
    reach.noteSeek();
    expect(reach.sample(2, clock.now)).toBe(6);
    clock.now += 250;
    expect(play(reach, clock, 2.25, 8)).toBe(8);
  });

  it('catches a forward jump nobody announced', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 2);
    expect(reach.sample(9, clock.now)).toBe(2);
    clock.now += 250;
    expect(play(reach, clock, 9.25, 11)).toBe(2);
  });

  it('keeps counting through a gap in the reports while the clip plays on (a held close, a busy main thread)', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 2);
    // Three seconds pass with no report, and the clip moves three seconds.
    clock.now += 3000;
    expect(reach.sample(5.25, clock.now)).toBe(5.25);
    clock.now += 250;
    expect(play(reach, clock, 5.5, 9.75)).toBe(9.75);
  });

  it('keeps counting reports that arrive late in a burst', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 2);
    clock.now += 2000;
    for (const seconds of [2.25, 2.5, 2.75, 3, 3.25]) reach.sample(seconds, clock.now);
    expect(reach.sample(3.5, clock.now)).toBe(3.5);
  });

  it('does not count a report from before the seek that arrives after it', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 2);
    reach.noteSeek();
    // A report sent just before the seek took effect, then the clip at its new place.
    expect(reach.sample(2.25, clock.now)).toBe(2);
    clock.now += 250;
    expect(reach.sample(9, clock.now)).toBe(2);
    clock.now += 250;
    expect(play(reach, clock, 9.25, 10)).toBe(2);
  });

  it('starts from nothing when the clip was moved before its first report', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    reach.noteSeek();
    expect(reach.sample(7, clock.now)).toBe(0);
    clock.now += 250;
    expect(play(reach, clock, 7.25, 8)).toBe(0);
  });

  it('ignores a broken report', () => {
    const clock = { now: 0 };
    const reach = createReelWatchReach();
    play(reach, clock, 0, 1);
    expect(reach.sample(Number.NaN, clock.now)).toBe(1);
    expect(reach.sample(-1, clock.now)).toBe(1);
  });
});

describe('createReelWatchVisit', () => {
  const report = (
    visit: ReturnType<typeof createReelWatchVisit>,
    seconds: number,
    now: number,
    extra: Partial<{ scrubbing: boolean; seekGeneration: number; durationSeconds: number }> = {},
  ) => visit.report({
    seconds,
    now,
    durationSeconds: extra.durationSeconds ?? 12,
    rate: 1,
    scrubbing: extra.scrubbing ?? false,
    seekGeneration: extra.seekGeneration ?? 0,
  });

  it('reports the share of the clip played, with its length', () => {
    const visit = createReelWatchVisit(0);
    for (let i = 0; i <= 12; i += 1) report(visit, i * 0.25, i * 250);
    expect(report(visit, 3.25, 3250)).toEqual({ progress: 3.25 / 12, durationMs: 12_000 });
  });

  it('keeps a scrubbed-to place unwatched through an overlay over the slide (comments, Details, the actions sheet)', () => {
    const visit = createReelWatchVisit(0);
    let now = 0;
    for (let at = 0; at <= 2; at += 0.25) {
      report(visit, at, now);
      now += 250;
    }
    // The reader drags to 11.9 s: one seek. Then comments open over the slide
    // (no reports while it is not the playing one) and close, and the clip
    // plays on from where it was left.
    now += 20_000;
    expect(report(visit, 11.9, now, { seekGeneration: 1 })?.progress).toBeCloseTo(2 / 12);
    now += 250;
    expect(report(visit, 11.95, now, { seekGeneration: 1 })?.progress).toBeCloseTo(2 / 12);
  });

  it('reports nothing while the bar is dragged', () => {
    const visit = createReelWatchVisit(0);
    report(visit, 0, 0);
    expect(report(visit, 6, 250, { scrubbing: true })).toBeNull();
  });

  it('counts a seek made before the visit had any report', () => {
    const visit = createReelWatchVisit(0);
    expect(report(visit, 9, 0, { seekGeneration: 1 })?.progress).toBe(0);
  });

  it('starts over for a new visit, where the clip is rewound', () => {
    const visit = createReelWatchVisit(0);
    for (let i = 0; i <= 40; i += 1) report(visit, i * 0.25, i * 250);
    visit.leave(3);
    expect(report(visit, 0, 20_000, { seekGeneration: 3 })?.progress).toBe(0);
    expect(report(visit, 0.25, 20_250, { seekGeneration: 3 })?.progress).toBeCloseTo(0.25 / 12);
  });

  it('reports nothing for a clip of no known length', () => {
    const visit = createReelWatchVisit(0);
    expect(report(visit, 1, 0, { durationSeconds: 0 })).toBeNull();
    expect(report(visit, 1, 0, { durationSeconds: Number.NaN })).toBeNull();
  });
});

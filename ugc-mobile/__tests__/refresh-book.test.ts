import { describe, expect, it } from 'vitest';

import {
  ANDROID_PULL_TRIGGER,
  PULL_ACTIVATE_DISTANCE,
  REFRESH_BOOK_CHIP,
  REFRESH_BOOK_LIFT_PHASE,
  REFRESH_BOOK_MIN_VISIBLE_MS,
  REFRESH_BOOK_PAGES,
  androidPullDecision,
  androidPullDistance,
  androidPullRefreshes,
  iosPulled,
  refreshBookChipTop,
  refreshBookHideDelayMs,
  refreshBookPageAngle,
  refreshBookPhase,
  refreshPullOffset,
  refreshPullProgress,
} from '../lib/refresh-book';

describe('refresh book page turns', () => {
  const pages = Array.from({ length: REFRESH_BOOK_PAGES }, (_, index) => index);

  it('starts every cycle with all pages flat on the right', () => {
    for (const page of pages) expect(refreshBookPageAngle(0, page)).toBe(0);
  });

  it('has every page land on the left before the cycle ends, so the reset to the right is between identical pictures', () => {
    for (const page of pages) expect(refreshBookPageAngle(0.99, page)).toBe(-180);
  });

  it('turns each page only one way, never back', () => {
    for (const page of pages) {
      let previous = 0;
      for (let step = 0; step <= 100; step += 1) {
        const angle = refreshBookPageAngle(step / 100, page);
        expect(angle).toBeLessThanOrEqual(previous);
        expect(angle).toBeGreaterThanOrEqual(-180);
        previous = angle;
      }
    }
  });

  it('turns the pages in order: a later page is never ahead of an earlier one', () => {
    for (let step = 0; step <= 100; step += 1) {
      for (let page = 1; page < REFRESH_BOOK_PAGES; page += 1) {
        expect(refreshBookPageAngle(step / 100, page)).toBeGreaterThanOrEqual(refreshBookPageAngle(step / 100, page - 1));
      }
    }
  });
});

describe('the book under a pull', () => {
  it('lifts the top page as the pull nears refreshing, and the turning carries on from there', () => {
    expect(refreshBookPhase(false, 0, 0)).toBe(0);
    const lifted = refreshBookPageAngle(refreshBookPhase(false, 0, 1), 0);
    // Most of the way to upright, short of crossing the spine.
    expect(lifted).toBeLessThan(-45);
    expect(lifted).toBeGreaterThan(-90);
    expect(refreshBookPhase(false, 0, 1)).toBe(REFRESH_BOOK_LIFT_PHASE);
  });

  it('turns on a clock that only grows, read through the cycle', () => {
    expect(refreshBookPhase(true, REFRESH_BOOK_LIFT_PHASE, 0)).toBeCloseTo(REFRESH_BOOK_LIFT_PHASE, 9);
    expect(refreshBookPhase(true, 3.25, 0)).toBeCloseTo(0.25, 9);
  });
});

describe('Android pull', () => {
  it('takes a move down at the list top before the list scroll would (8dp touch slop)', () => {
    expect(PULL_ACTIVATE_DISTANCE).toBeLessThan(8);
    expect(androidPullDecision(0, PULL_ACTIVATE_DISTANCE, true)).toBe('pull');
    expect(androidPullDecision(1, PULL_ACTIVATE_DISTANCE - 1, true)).toBe('wait');
  });

  it('leaves every touch to the list away from its top', () => {
    expect(androidPullDecision(0, 40, false)).toBe('pass');
  });

  it('leaves an upward move to the list scroll', () => {
    expect(androidPullDecision(0, -PULL_ACTIVATE_DISTANCE, true)).toBe('pass');
  });

  it('leaves a sideways move to the row or pager under the finger', () => {
    expect(androidPullDecision(PULL_ACTIVATE_DISTANCE, 2, true)).toBe('pass');
    expect(androidPullDecision(-PULL_ACTIVATE_DISTANCE - 2, PULL_ACTIVATE_DISTANCE, true)).toBe('pass');
  });

  it('counts the pull from where it took the touch, and refreshes only past the trigger', () => {
    expect(androidPullDistance(PULL_ACTIVATE_DISTANCE)).toBe(0);
    expect(androidPullDistance(PULL_ACTIVATE_DISTANCE + 50)).toBe(50);
    expect(androidPullRefreshes(ANDROID_PULL_TRIGGER - 1)).toBe(false);
    expect(androidPullRefreshes(ANDROID_PULL_TRIGGER)).toBe(true);
  });

  it('brings the circle down with the finger to its rest at the trigger, then gives only a little', () => {
    expect(refreshPullOffset('android', 0)).toBeLessThan(-REFRESH_BOOK_CHIP.size);
    expect(refreshPullOffset('android', ANDROID_PULL_TRIGGER)).toBe(0);
    let previous = refreshPullOffset('android', 0);
    for (let pulled = 10; pulled <= 400; pulled += 10) {
      const offset = refreshPullOffset('android', pulled);
      expect(offset).toBeGreaterThanOrEqual(previous);
      previous = offset;
    }
    expect(refreshPullOffset('android', 1000)).toBeLessThanOrEqual(40);
  });

  it('rests the circle under the content inset, or below a first row of controls when told where', () => {
    expect(refreshBookChipTop('android', 47)).toBe(47 + 8);
    expect(refreshBookChipTop('android', 47, 120)).toBe(120);
  });
});

describe('iOS pull', () => {
  it('reads the pull from the list scroll offset', () => {
    expect(iosPulled(0)).toBe(0);
    expect(iosPulled(250)).toBe(0);
    expect(iosPulled(-72)).toBe(72);
  });

  it('carries the circle with the content and rests it centred in the 60pt gap the control holds open', () => {
    expect(refreshPullOffset('ios', 60)).toBe(0);
    expect(refreshPullOffset('ios', 100)).toBe(40);
    const top = refreshBookChipTop('ios', 59);
    expect(top + REFRESH_BOOK_CHIP.size / 2).toBe(59 + 30);
    // iOS opens its gap above the content whatever the first row is.
    expect(refreshBookChipTop('ios', 59, 120)).toBe(top);
  });

  it('fills the pull progress by the time the control refreshes', () => {
    expect(refreshPullProgress('ios', 0)).toBe(0);
    expect(refreshPullProgress('ios', 100)).toBe(1);
    expect(refreshPullProgress('ios', 400)).toBe(1);
  });
});

describe('the chip once up', () => {
  it('holds for at least one page turn, and no longer than needed', () => {
    expect(refreshBookHideDelayMs(1_000, 1_100)).toBe(REFRESH_BOOK_MIN_VISIBLE_MS - 100);
    expect(refreshBookHideDelayMs(1_000, 1_000 + REFRESH_BOOK_MIN_VISIBLE_MS + 5)).toBe(0);
    // A clock that went backwards waits the whole minimum, never more.
    expect(refreshBookHideDelayMs(1_000, 900)).toBe(REFRESH_BOOK_MIN_VISIBLE_MS);
  });
});

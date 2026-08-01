import { describe, expect, it } from 'vitest';

import {
  HOME_SLIDE_LOOP_PASSES,
  advanceHomeSlide,
  buildLoopedHomeSlides,
  getCenteredHomeSlideIndex,
  getHomeSlideFoldShift,
  getHomeSlideReleaseIndex,
  getHomeSlides,
  getInitialHomeSlideIndex,
  getNearestHomeSlideIndex,
  shouldAutoAdvanceHomeSlides,
} from '@/lib/home-slider';

/**
 * The web twin of ugc-mobile/__tests__/home-feed-view-model.test.ts. Both rails
 * loop by the same rules, so the two suites assert the same guarantees.
 */
describe('home slider', () => {
  describe('slides', () => {
    it('opens with the workspace card, then the tools that have preview art', () => {
      const slides = getHomeSlides();

      expect(slides[0]).toMatchObject({ kind: 'workspace', href: '/create' });
      expect(slides.slice(1).map((slide) => slide.id)).toEqual(['image', 'video', 'motion']);
      expect(slides.slice(1).every((slide) => slide.kind === 'tool' && slide.preview)).toBe(true);
    });

    it('points every tool at its real create route', () => {
      const hrefs = getHomeSlides().filter((slide) => slide.kind === 'tool').map((slide) => slide.href);

      expect(hrefs).toEqual(['/create-image', '/create-video', '/create-motion']);
    });
  });

  describe('rotation', () => {
    it('advances one slide at a time', () => {
      expect(advanceHomeSlide(4, 4)).toBe(5);
      expect(advanceHomeSlide(6, 4)).toBe(7);
    });

    it('keeps going forward past the last slide instead of rewinding', () => {
      // Index 8 is the next pass's copy of the first slide, so the rail travels
      // on in the same direction rather than sweeping back.
      expect(advanceHomeSlide(7, 4)).toBe(8);
    });

    it('stays put when there is nothing to rotate through', () => {
      expect(advanceHomeSlide(0, 1)).toBe(0);
      expect(advanceHomeSlide(0, 0)).toBe(0);
    });

    it('starts in the middle pass so a backward scroll has somewhere to go', () => {
      expect(getInitialHomeSlideIndex(4)).toBe(4);
      expect(getInitialHomeSlideIndex(1)).toBe(0);
    });

    it('rotates only while visible, untouched, and motion is allowed', () => {
      const running = { slideCount: 4, isVisible: true, isInteracting: false, reduceMotion: false };

      expect(shouldAutoAdvanceHomeSlides(running)).toBe(true);
      expect(shouldAutoAdvanceHomeSlides({ ...running, isVisible: false })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, isInteracting: true })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, reduceMotion: true })).toBe(false);
      expect(shouldAutoAdvanceHomeSlides({ ...running, slideCount: 1 })).toBe(false);
    });
  });

  describe('looped layout', () => {
    it('lays the slides out three times with unique keys', () => {
      const slides = getHomeSlides();
      const looped = buildLoopedHomeSlides(slides);

      expect(looped).toHaveLength(slides.length * HOME_SLIDE_LOOP_PASSES);
      expect(new Set(looped.map((entry) => entry.key)).size).toBe(looped.length);
      expect(looped[slides.length].slide).toBe(slides[0]);
    });

    it('marks exactly one pass canonical, and it is the one the rail rests in', () => {
      const slides = getHomeSlides();
      const looped = buildLoopedHomeSlides(slides);
      const canonical = looped.filter((entry) => entry.isCanonical);

      expect(canonical).toHaveLength(slides.length);
      // The resting index must land inside the canonical pass, or the copy the
      // user actually looks at would be the one hidden from assistive tech.
      expect(looped[getInitialHomeSlideIndex(slides.length)].isCanonical).toBe(true);
    });

    it('leaves a single slide unrepeated and canonical', () => {
      const [only] = getHomeSlides();
      const looped = buildLoopedHomeSlides([only]);

      expect(looped).toHaveLength(1);
      expect(looped[0].isCanonical).toBe(true);
    });
  });

  describe('folding back to the middle pass', () => {
    // A fractional pass, as a percentage-width card actually produces: four
    // slides of 598.4 + 10px. Exactly the case an offset-boundary comparison
    // got wrong — the scroll rests a hair short of the boundary and the wrap
    // is missed for a whole cycle.
    const OFFSETS = Array.from({ length: 12 }, (_, i) => i * 608.4);
    const PASS = 608.4 * 4;

    it('maps a settled slide onto its middle-pass copy', () => {
      expect(getCenteredHomeSlideIndex(8, 4)).toBe(4);
      expect(getCenteredHomeSlideIndex(9, 4)).toBe(5);
      expect(getCenteredHomeSlideIndex(3, 4)).toBe(7);
      expect(getCenteredHomeSlideIndex(6, 4)).toBe(6);
    });

    it('shifts a forward wrap back by exactly one pass', () => {
      expect(getHomeSlideFoldShift(8, 4, OFFSETS)).toBeCloseTo(PASS, 6);
    });

    it('shifts a backward wrap forward by exactly one pass', () => {
      // Scrolled back off the first slide of the middle pass into pass one.
      expect(getHomeSlideFoldShift(3, 4, OFFSETS)).toBeCloseTo(-PASS, 6);
    });

    it('asks for no shift when already centred', () => {
      // No scroll is issued on a zero shift, so at-rest settles stay free.
      for (const index of [4, 5, 6, 7]) {
        expect(getHomeSlideFoldShift(index, 4, OFFSETS)).toBe(0);
      }
    });

    it('always moves by a whole number of passes', () => {
      for (let index = 0; index < OFFSETS.length; index += 1) {
        const shift = getHomeSlideFoldShift(index, 4, OFFSETS);
        const centered = getCenteredHomeSlideIndex(index, 4);

        expect(Math.abs(shift / PASS - Math.round(shift / PASS))).toBeLessThan(1e-9);
        // Landing anywhere but the middle pass would leave the rail without a
        // full copy on one side, which is what the seam and the dead end were.
        expect(centered).toBeGreaterThanOrEqual(4);
        expect(centered).toBeLessThan(8);
        // The correction must never change which slide is on screen.
        expect(centered % 4).toBe(index % 4);
      }
    });

    it('is a no-op before the track has been measured', () => {
      expect(getHomeSlideFoldShift(8, 4, [])).toBe(0);
      expect(getHomeSlideFoldShift(0, 1, OFFSETS)).toBe(0);
    });
  });

  describe('releasing a drag', () => {
    const COUNT = 12;

    it('leaves a slow drag on the card it was placed on', () => {
      // Below the flick threshold the rail should not travel further than the
      // hand took it — overshooting a deliberate placement feels like a fight.
      expect(getHomeSlideReleaseIndex(6, 0, COUNT)).toBe(6);
      expect(getHomeSlideReleaseIndex(6, -0.2, COUNT)).toBe(6);
      expect(getHomeSlideReleaseIndex(6, 0.2, COUNT)).toBe(6);
    });

    it('carries a flick one card in the direction it was thrown', () => {
      // A pointer moving left drags the content left, towards the next card.
      expect(getHomeSlideReleaseIndex(6, -0.8, COUNT)).toBe(7);
      expect(getHomeSlideReleaseIndex(6, 0.8, COUNT)).toBe(5);
    });

    it('never carries more than one card, however hard the throw', () => {
      expect(getHomeSlideReleaseIndex(6, -25, COUNT)).toBe(7);
      expect(getHomeSlideReleaseIndex(6, 25, COUNT)).toBe(5);
    });

    it('cannot be thrown off either end of the laid-out rail', () => {
      expect(getHomeSlideReleaseIndex(0, 5, COUNT)).toBe(0);
      expect(getHomeSlideReleaseIndex(COUNT - 1, -5, COUNT)).toBe(COUNT - 1);
    });

    it('survives being asked before the track has children', () => {
      expect(getHomeSlideReleaseIndex(0, -2, 0)).toBe(0);
    });
  });

  describe('measured positions', () => {
    const OFFSETS = [0, 310, 620, 930, 1240, 1550];

    it('resolves the nearest slide to a settled offset', () => {
      expect(getNearestHomeSlideIndex(0, OFFSETS)).toBe(0);
      expect(getNearestHomeSlideIndex(1240, OFFSETS)).toBe(4);
      // Snapping settles a few pixels off often enough to round, not floor.
      expect(getNearestHomeSlideIndex(1236, OFFSETS)).toBe(4);
    });

    it('clamps an overscrolled offset to a real slide', () => {
      expect(getNearestHomeSlideIndex(-400, OFFSETS)).toBe(0);
      expect(getNearestHomeSlideIndex(9000, OFFSETS)).toBe(OFFSETS.length - 1);
    });

    it('survives being asked before the track has children', () => {
      expect(getNearestHomeSlideIndex(120, [])).toBe(0);
    });
  });
});

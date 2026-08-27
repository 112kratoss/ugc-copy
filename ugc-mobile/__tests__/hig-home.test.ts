import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getHomeFeedSlides } from '../lib/home-feed-view-model';

/**
 * S4's rules, in the form a suite can hold. Sources: Toolbars, Branding,
 * Page controls, Scroll views, Motion.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const dashboard = read('components/home-dashboard.tsx');
const authScreen = read('app/auth.tsx');

/** Slice one function out of a 1,400-line file rather than matching across it. */
function declaration(source: string, header: string) {
  const start = source.indexOf(header);
  expect(start, `missing ${header}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + header.length);
  return source.slice(start, next === -1 ? undefined : next);
}

const topBar = declaration(dashboard, 'function HomeTopBar(');
const slider = declaration(dashboard, 'function TopSlider(');
const dots = declaration(dashboard, 'function SlideDots(');

describe('the home top bar', () => {
  /**
   * Toolbars: "Don't title windows with your app name. Your app's name doesn't
   * provide useful information about your content hierarchy or any window or
   * area in your app, so it doesn't work well as a title." Branding says the
   * same thing from the other side: "people seldom need to be reminded which
   * app they're using, and it's usually better to use the space to give people
   * valuable information and controls."
   */
  it('does not title the view with the app name', () => {
    expect(topBar).not.toContain('Magicbooklet');
  });

  /**
   * The brand still opens the app. Branding endorses exactly that placement —
   * "you might consider displaying a welcome or onboarding screen that
   * incorporates your branding content at the beginning of your experience".
   */
  it('keeps the wordmark where the chapter endorses it', () => {
    // S3 gave the four surfaces that drew this lockup by hand — at four sizes —
    // one `BrandLockup`, so the assertion moved from auth's own markup to the
    // control it mounts. The name itself is asserted in hig-onboarding.
    expect(authScreen).toContain('<BrandLockup />');
  });

  /**
   * S10 renamed this destination; the label that opens it had not caught up, so
   * a screen reader announced a name the app no longer uses anywhere.
   */
  it('names the destination the way the app names it', () => {
    expect(topBar).toContain('accessibilityLabel="Open alerts"');
    expect(topBar).not.toContain('studio activity');
  });
});

describe('the top carousel says how much of it there is', () => {
  /**
   * Scroll views: "Consider showing a page control when a scroll view is in
   * page-by-page mode … If you show a page control with a scroll view, don't
   * show the scrolling indicator on the same axis to avoid confusing people
   * with redundant controls."
   */
  it('shows a page control under a page-by-page rail', () => {
    expect(slider).toContain('<SlideDots count={slides.length} index={pageIndex} />');
    expect(slider).toContain('snapToInterval={slideWidth + gap}');
  });

  it('keeps the scroll indicator off the same axis', () => {
    expect(slider).toContain('showsHorizontalScrollIndicator={false}');
  });

  /** Page controls: "more than about 10 dots are hard to count at a glance." */
  it('has few enough dots to count at a glance', () => {
    const slideCount = getHomeFeedSlides().length;
    expect(slideCount).toBeGreaterThan(1);
    expect(slideCount).toBeLessThanOrEqual(10);
  });

  it('draws nothing when there is nothing to page through', () => {
    expect(dots).toContain('if (count < 2) return null;');
  });

  /**
   * Page controls: "Avoid coloring indicator images. Custom colors can reduce
   * the contrast that differentiates the current-page indicator."
   */
  it('separates the current dot by contrast, not by hue', () => {
    expect(dots).toContain('DASHBOARD_COLORS.text : DASHBOARD_COLORS.border');
    expect(dots).not.toContain('coral');
  });

  it('tells a screen reader where in the set it is', () => {
    expect(dots).toContain('accessibilityLabel={`Slide ${Math.min(index + 1, count)} of ${count}`}');
  });

  /**
   * Three things move the rail — the timer, a settled swipe, and the jump into
   * the middle pass on load — and the dots have to follow all three or they
   * lie. The timer's own position stays a ref, so this state never lands in
   * the interval effect's deps and can never restart it mid-cycle.
   */
  it('follows the rail however it moved', () => {
    expect(slider).toContain('setPageIndex(nextIndex % slides.length)');
    expect(slider).toContain('setPageIndex(slideIndexRef.current % slides.length)');
    expect(slider).toContain('setPageIndex(initialIndex % slides.length)');
    const interval = slider.slice(slider.indexOf('const timer = setInterval'));
    expect(interval).toContain('}, [autoAdvance, gap, slideWidth, slides.length]);');
  });

  /**
   * Motion: "Make motion optional … avoid using it as the only way to
   * communicate important information", and "let people cancel motion". The
   * rotation already stops for Reduce Motion, for a blur, and for a touch —
   * pinned in `home-feed-view-model.test.ts` — which is exactly when the dots
   * become the only thing saying there are four slides.
   */
  it('leaves the rotation gated the way it was', () => {
    expect(slider).toContain('shouldAutoAdvanceHomeSlides({');
    expect(slider).toContain('reduceMotion,');
  });
});

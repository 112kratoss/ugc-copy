import { describe, expect, it } from 'vitest';

import {
  MEDIA_SPARKLE_CLOCK_SPAN_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_FADE_MS,
  MEDIA_SPARKLE_FULL_BOX,
  MEDIA_SPARKLE_TRIO,
  mediaSparkleLook,
  mediaSparkleStateFor,
  mediaSparkleTrioScale,
  mediaSparkleTwinkle,
  sparklePath,
} from '../lib/media-loading-sparkle';
import { MEDIA_SKETCH_DELAY_MS } from '../lib/media-sketch';

const WAITING = -1;

describe('loading sparkle rules', () => {
  it('waits as long as the picture sketch does before drawing', () => {
    expect(MEDIA_SPARKLE_DELAY_MS).toBe(MEDIA_SKETCH_DELAY_MS);
  });

  it('draws the three at full size on a full screen, smaller in a small player, and not at all in a tiny box', () => {
    expect(mediaSparkleTrioScale(390, 844)).toBe(1);
    expect(mediaSparkleTrioScale(160, 80)).toBe(1);
    expect(mediaSparkleTrioScale(120, 300)).toBeCloseTo(0.75);
    expect(mediaSparkleTrioScale(300, 60)).toBeCloseTo(0.75);
    expect(mediaSparkleTrioScale(96, 48)).toBeCloseTo(0.6);
    expect(mediaSparkleTrioScale(95, 300)).toBeNull();
    expect(mediaSparkleTrioScale(300, 47)).toBeNull();
  });

  it('keeps the three inside a full-size box at the top of a twinkle', () => {
    const { arm, spacing } = MEDIA_SPARKLE_TRIO;
    const widest = 2 * spacing + 2 * arm * 1.15;
    expect(widest).toBeLessThanOrEqual(MEDIA_SPARKLE_FULL_BOX.width / 2);
  });

  it('draws the logo\'s four-pointed sparkle, its points on the square it is centred in', () => {
    const path = sparklePath(9);
    expect(path.startsWith('M9 0 ')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(4);
    expect(path).toContain(' 18 9 C');
    expect(path).toContain(' 9 18 C');
    expect(path).toContain(' 0 9 C');
    expect(path.endsWith('9 0 Z')).toBe(true);
    // Each side curves in toward the middle, well inside the straight line between two points.
    expect(path).toContain('C9.54 6.3 11.7 8.46 18 9');
  });

  it('twinkles the three in turn, never two at their brightest together', () => {
    for (let time = 0; time < MEDIA_SPARKLE_TRIO.cycleMs; time += 20) {
      const twinkles = [0, 1, 2].map((index) => mediaSparkleTwinkle(time, index));
      twinkles.forEach((twinkle) => {
        expect(twinkle).toBeGreaterThanOrEqual(0);
        expect(twinkle).toBeLessThanOrEqual(1);
      });
      expect(twinkles.filter((twinkle) => twinkle > 0.9).length).toBeLessThanOrEqual(1);
    }
    const peak = MEDIA_SPARKLE_TRIO.pulseMs / 2;
    expect(mediaSparkleTwinkle(peak, 0)).toBeCloseTo(1);
    expect(mediaSparkleTwinkle(peak + MEDIA_SPARKLE_TRIO.staggerMs, 1)).toBeCloseTo(1);
  });

  it('grows and brightens with a twinkle, only brightens under Reduce Motion, and fades out to nothing', () => {
    const peak = MEDIA_SPARKLE_TRIO.pulseMs / 2;
    const top = mediaSparkleLook(peak, 0, WAITING, false);
    expect(top.opacity).toBeCloseTo(1);
    expect(top.scale).toBeCloseTo(1.15);
    const rest = mediaSparkleLook(MEDIA_SPARKLE_TRIO.cycleMs - 1, 0, WAITING, false);
    expect(rest.opacity).toBeCloseTo(0.3);
    expect(rest.scale).toBeCloseTo(0.55);
    const still = mediaSparkleLook(peak, 0, WAITING, true);
    expect(still.opacity).toBeCloseTo(1);
    expect(still.scale).toBe(1);
    expect(mediaSparkleLook(peak, 0, MEDIA_SPARKLE_FADE_MS / 2, false).opacity).toBeCloseTo(0.5);
    expect(mediaSparkleLook(peak, 0, MEDIA_SPARKLE_FADE_MS, false).opacity).toBe(0);
  });

  it('reads a player\'s wait from its status: waiting while it loads, ready to fade when it can play, gone otherwise', () => {
    expect(mediaSparkleStateFor('idle')).toBe('loading');
    expect(mediaSparkleStateFor('loading')).toBe('loading');
    expect(mediaSparkleStateFor('readyToPlay')).toBe('ready');
    expect(mediaSparkleStateFor('error')).toBe('gone');
    // The reel's zoom has not landed: nothing yet, and a clip ready by then needs no fade.
    expect(mediaSparkleStateFor('loading', { shown: false })).toBe('gone');
    expect(mediaSparkleStateFor('readyToPlay', { shown: false })).toBe('ready');
    // A player that has failed or given up waiting ends it, whatever its status still says.
    expect(mediaSparkleStateFor('loading', { failed: true })).toBe('gone');
    expect(mediaSparkleStateFor('readyToPlay', { failed: true })).toBe('gone');
  });

  it('runs on a clock whose loop has no seam', () => {
    expect(MEDIA_SPARKLE_CLOCK_SPAN_MS % MEDIA_SPARKLE_TRIO.cycleMs).toBe(0);
  });
});

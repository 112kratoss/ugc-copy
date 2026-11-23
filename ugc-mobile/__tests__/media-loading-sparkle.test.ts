import { describe, expect, it } from 'vitest';

import {
  MEDIA_SPARKLE_BREATH_MS,
  MEDIA_SPARKLE_BURST_MOTES,
  MEDIA_SPARKLE_BURST_MS,
  MEDIA_SPARKLE_CANVAS,
  MEDIA_SPARKLE_CLOCK_SPAN_MS,
  MEDIA_SPARKLE_DELAY_MS,
  MEDIA_SPARKLE_DRIFT_MOTES,
  MEDIA_SPARKLE_ARM,
  MEDIA_SPARKLE_TRIO,
  mediaSparkleBreath,
  mediaSparkleBurstMote,
  mediaSparkleDotOpacity,
  mediaSparkleDriftFade,
  mediaSparkleDriftMote,
  mediaSparkleGlow,
  mediaSparkleKind,
  mediaSparkleScale,
  mediaSparkleTwinkle,
  sparklePath,
} from '../lib/media-loading-sparkle';
import { MEDIA_SKETCH_DELAY_MS } from '../lib/media-sketch';

const R = MEDIA_SPARKLE_ARM;
const WAITING = -1;

describe('loading sparkle rules', () => {
  it('waits as long as the picture sketch does before drawing', () => {
    expect(MEDIA_SPARKLE_DELAY_MS).toBe(MEDIA_SKETCH_DELAY_MS);
  });

  it('gives a full screen the sparkle, a small player the trio and a tiny box the spinner', () => {
    expect(mediaSparkleKind(390, 844)).toBe('sparkle');
    expect(mediaSparkleKind(180, 180)).toBe('sparkle');
    expect(mediaSparkleKind(179, 320)).toBe('trio');
    expect(mediaSparkleKind(320, 120)).toBe('trio');
    expect(mediaSparkleKind(64, 36)).toBe('trio');
    expect(mediaSparkleKind(63, 120)).toBe('spinner');
    expect(mediaSparkleKind(120, 35)).toBe('spinner');
  });

  it('draws the logo\'s four-pointed sparkle, its points on the square it is centred in', () => {
    const path = sparklePath(22);
    expect(path.startsWith('M22 0 ')).toBe(true);
    expect(path.match(/C/g)).toHaveLength(4);
    expect(path).toContain(' 44 22 C');
    expect(path).toContain(' 22 44 C');
    expect(path).toContain(' 0 22 C');
    expect(path.endsWith('22 0 Z')).toBe(true);
    // Each side curves in toward the middle, well inside the straight line between two points.
    expect(path).toContain('C23.32 15.4 28.6 20.68 44 22');
  });

  it('breathes between rest and a gentle swell, its glow and dot with it', () => {
    expect(mediaSparkleBreath(0)).toBeCloseTo(0);
    expect(mediaSparkleBreath(MEDIA_SPARKLE_BREATH_MS / 2)).toBeCloseTo(1);
    expect(mediaSparkleBreath(MEDIA_SPARKLE_BREATH_MS)).toBeCloseTo(0);
    for (let time = 0; time <= MEDIA_SPARKLE_BREATH_MS; time += 50) {
      const scale = mediaSparkleScale(time, WAITING);
      expect(scale).toBeGreaterThanOrEqual(0.92 - 1e-9);
      expect(scale).toBeLessThanOrEqual(1.04 + 1e-9);
      expect(mediaSparkleGlow(time, WAITING)).toBeGreaterThan(0.4);
      expect(mediaSparkleDotOpacity(time, WAITING)).toBeGreaterThanOrEqual(0.6 - 1e-9);
    }
  });

  it('swells, then pops, and leaves nothing behind once the burst is over', () => {
    expect(mediaSparkleScale(0, 0)).toBeCloseTo(1);
    expect(mediaSparkleScale(0, 140)).toBeCloseTo(1.3);
    expect(mediaSparkleScale(0, 360)).toBeCloseTo(0);
    expect(mediaSparkleGlow(0, 140)).toBeCloseTo(1);
    expect(mediaSparkleGlow(0, 440)).toBe(0);
    expect(mediaSparkleDotOpacity(0, 250)).toBe(0);
    expect(mediaSparkleDriftFade(120)).toBe(0);
    for (const time of [MEDIA_SPARKLE_BURST_MS, MEDIA_SPARKLE_BURST_MS + 100]) {
      expect(mediaSparkleScale(0, time)).toBeCloseTo(0);
      expect(mediaSparkleGlow(0, time)).toBe(0);
      MEDIA_SPARKLE_BURST_MOTES.forEach((_, index) => expect(mediaSparkleBurstMote(time, index, R).opacity).toBe(0));
    }
  });

  it('throws its burst all the way round, and keeps every mote inside the drawing', () => {
    const quadrants = new Set(MEDIA_SPARKLE_BURST_MOTES.map((mote) => Math.floor((((mote.angle % 360) + 360) % 360) / 90)));
    expect(quadrants.size).toBe(4);
    let seen = 0;
    for (let time = 0; time <= MEDIA_SPARKLE_BURST_MS; time += 10) {
      MEDIA_SPARKLE_BURST_MOTES.forEach((spec, index) => {
        const mote = mediaSparkleBurstMote(time, index, R);
        if (mote.opacity <= 0) return;
        seen += 1;
        const reach = Math.hypot(mote.x, mote.y) + spec.size * R * mote.scale;
        expect(reach).toBeLessThanOrEqual(MEDIA_SPARKLE_CANVAS / 2);
      });
    }
    expect(seen).toBeGreaterThan(0);
    // No mote shows before the swell is over.
    MEDIA_SPARKLE_BURST_MOTES.forEach((_, index) => expect(mediaSparkleBurstMote(100, index, R).opacity).toBe(0));
  });

  it('sheds three motes at the top of each breath, each breath turned on from the last', () => {
    const top = MEDIA_SPARKLE_BREATH_MS / 2;
    // Nothing before the first breath's top.
    MEDIA_SPARKLE_DRIFT_MOTES.forEach((_, index) => expect(mediaSparkleDriftMote(top - 1, index, R).opacity).toBe(0));
    const first = mediaSparkleDriftMote(top + 400, 0, R);
    expect(first.opacity).toBeGreaterThan(0);
    expect(Math.hypot(first.x, first.y)).toBeGreaterThan(0.6 * R);
    const next = mediaSparkleDriftMote(top + MEDIA_SPARKLE_BREATH_MS + 400, 0, R);
    expect(next.opacity).toBeCloseTo(first.opacity);
    const turned = Math.atan2(next.y, next.x) - Math.atan2(first.y, first.x);
    expect(((turned * 180) / Math.PI + 360) % 360).toBeCloseTo(47);
    // Every mote has landed before the next breath sheds again.
    MEDIA_SPARKLE_DRIFT_MOTES.forEach((_, index) => {
      expect(mediaSparkleDriftMote(top + MEDIA_SPARKLE_BREATH_MS - 1, index, R).opacity).toBe(0);
    });
  });

  it('twinkles the trio in turn, never all three at their brightest together', () => {
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

  it('runs on a clock whose loop has no seam', () => {
    expect(MEDIA_SPARKLE_CLOCK_SPAN_MS % MEDIA_SPARKLE_BREATH_MS).toBe(0);
    expect(MEDIA_SPARKLE_CLOCK_SPAN_MS % MEDIA_SPARKLE_TRIO.cycleMs).toBe(0);
  });
});

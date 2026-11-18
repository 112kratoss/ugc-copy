import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import BrandMark, { brandMarkSparks, replayBrandMark } from '@/components/brand/BrandMark';

describe('brand mark', () => {
  it('throws the launch sting\'s 16 sparkles, stars first, the first straight up from the star', () => {
    const sparks = brandMarkSparks();
    expect(sparks).toHaveLength(16);
    expect(sparks.map((spark) => spark.shape)).toEqual([...Array(9).fill('star'), ...Array(7).fill('dot')]);
    // k = 0 leaves at -90 degrees give or take the script's quarter-radian jitter.
    expect(Math.abs(sparks[0].x)).toBeLessThan(Math.abs(sparks[0].y) * Math.tan(0.25) + 0.01);
    expect(sparks[0].y).toBeLessThan(0);
    for (const spark of sparks) {
      expect(spark.delay).toBeGreaterThanOrEqual(0);
      expect(spark.delay).toBeLessThanOrEqual(0.06);
      expect(spark.radius).toBeGreaterThan(0);
    }
    // Seeded: the same burst on the server and in the browser.
    expect(brandMarkSparks()).toEqual(sparks);
  });

  it('is decorative, so the brand link keeps its own name', () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector('.brand-mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('alt'))).toEqual(['', '', '']);
    expect(container.querySelectorAll('.brand-mark-spark')).toHaveLength(16);
  });

  it('rewinds a finished sting and leaves a playing one alone', () => {
    const finished = { playState: 'finished', currentTime: 1150, play: vi.fn() };
    const element = { getAnimations: vi.fn(() => [finished]) } as unknown as HTMLElement;
    replayBrandMark(element);
    expect(finished.currentTime).toBe(0);
    expect(finished.play).toHaveBeenCalledTimes(1);

    const running = { playState: 'running', currentTime: 400, play: vi.fn() };
    const other = { playState: 'finished', currentTime: 770, play: vi.fn() };
    replayBrandMark({ getAnimations: vi.fn(() => [running, other]) } as unknown as HTMLElement);
    expect(running.currentTime).toBe(400);
    expect(other.play).not.toHaveBeenCalled();
  });

  it('keeps the still icon where the Web Animations API is missing', () => {
    expect(() => replayBrandMark({} as HTMLElement)).not.toThrow();
    expect(() => replayBrandMark(null)).not.toThrow();
  });
});

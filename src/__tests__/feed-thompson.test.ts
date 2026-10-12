import { describe, expect, it } from 'vitest';

import { mulberry32, sampleBeta, sampleGamma } from '@/lib/feed-thompson';

function draws(count: number, next: () => number) {
  return Array.from({ length: count }, () => next());
}

describe('mulberry32', () => {
  it('replays the same sequence from the same seed', () => {
    const left = mulberry32(20261011);
    const right = mulberry32(20261011);
    const sequence = draws(1000, left);

    expect(sequence).toEqual(draws(1000, right));
    expect(sequence.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('gives different seeds different sequences', () => {
    expect(draws(5, mulberry32(1))).not.toEqual(draws(5, mulberry32(2)));
  });

  it('matches the reference mulberry32 stream, so a stored session seed replays across releases', () => {
    const random = mulberry32(1);
    expect(draws(3, random)).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  });
});

describe('sampleBeta', () => {
  it('replays identical draws from the same seed', () => {
    const left = mulberry32(42);
    const right = mulberry32(42);

    expect(draws(200, () => sampleBeta(7.5, 42.5, left)))
      .toEqual(draws(200, () => sampleBeta(7.5, 42.5, right)));
  });

  it('centres 10,000 draws of Beta(7.5, 42.5) on 0.15, each strictly inside (0, 1)', () => {
    const random = mulberry32(20261011);
    const sample = draws(10_000, () => sampleBeta(7.5, 42.5, random));
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;

    expect(Math.abs(mean - 0.15)).toBeLessThan(0.01);
    expect(sample.every((value) => value > 0 && value < 1)).toBe(true);
  });

  it('samples shapes below 1 through the boost (X prior Beta(0.75, 49.25))', () => {
    const random = mulberry32(20261011);
    const sample = draws(10_000, () => sampleBeta(0.75, 49.25, random));
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;

    expect(Math.abs(mean - 0.015)).toBeLessThan(0.002);
    expect(sample.every((value) => value > 0 && value < 1)).toBe(true);
  });

  it('rejects shapes that are not positive and finite', () => {
    const random = mulberry32(1);
    expect(() => sampleBeta(0, 1, random)).toThrow(RangeError);
    expect(() => sampleBeta(1, Number.NaN, random)).toThrow(RangeError);
    expect(() => sampleGamma(-1, random)).toThrow(RangeError);
  });
});

describe('sampleGamma', () => {
  it.each([0.3, 2.5, 40])('has mean ≈ shape for Gamma(%s, 1)', (shape) => {
    const random = mulberry32(3);
    const sample = draws(10_000, () => sampleGamma(shape, random));
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;

    // Standard error is √shape/100; allow about four of them.
    expect(Math.abs(mean - shape)).toBeLessThan(0.04 * Math.sqrt(shape) + 0.01);
    expect(sample.every((value) => value > 0)).toBe(true);
  });
});

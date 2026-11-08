import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Animated: { Value: class {}, View: () => null, timing: () => ({}), parallel: () => ({}) },
  Easing: { bezier: () => () => 0 },
  View: () => null,
}));
vi.mock('lucide-react-native', () => ({ Sparkle: () => null }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: {} }) }));

import { claimSparklePieces } from '../components/claim-sparkles';

describe('the claim celebration stays quiet (owner 11-09: "premium", not confetti)', () => {
  const pieces = claimSparklePieces();

  it('is a dozen sparkles, the same every time', () => {
    expect(pieces).toHaveLength(12);
    expect(claimSparklePieces()).toEqual(pieces);
  });

  it('starts along the button, rises a short way and stays small', () => {
    for (const piece of pieces) {
      expect(Math.abs(piece.along)).toBeLessThanOrEqual(0.5);
      expect(piece.rise).toBeGreaterThanOrEqual(70);
      expect(piece.rise).toBeLessThanOrEqual(180);
      expect(Math.abs(piece.drift)).toBeLessThanOrEqual(24);
      expect(piece.peakScale).toBeLessThanOrEqual(1.3);
    }
  });

  it('cascades: staggered starts spread over less than half a second', () => {
    const delays = pieces.map((piece) => piece.delay);
    expect(new Set(delays).size).toBe(pieces.length);
    expect(Math.max(...delays)).toBeLessThan(450);
  });
});

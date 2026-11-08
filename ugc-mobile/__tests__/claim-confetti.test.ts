import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Animated: { Value: class {}, View: () => null, timing: () => ({}), parallel: () => ({}) },
  Easing: { linear: () => 0 },
  View: () => null,
}));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: {} }) }));

import { CLAIM_CONFETTI_MS, claimConfettiPieces } from '../components/claim-confetti';

describe('the claim confetti (owner 11-09: "premium feel ... satisfaction of gaining something")', () => {
  const pieces = claimConfettiPieces();

  it('is a few dozen pieces, the same every time, in five tones and three shapes', () => {
    expect(pieces).toHaveLength(48);
    expect(claimConfettiPieces()).toEqual(pieces);
    expect(new Set(pieces.map((piece) => piece.tone)).size).toBe(5);
    expect(new Set(pieces.map((piece) => piece.shape))).toEqual(new Set(['strip', 'chip', 'dot']));
    for (const piece of pieces) {
      expect(piece.width).toBeLessThanOrEqual(10);
      expect(piece.height).toBeLessThanOrEqual(18);
    }
  });

  it('is one burst: every piece is away within a tenth of a second', () => {
    for (const piece of pieces) expect(piece.delay).toBeLessThan(100);
    expect(new Set(pieces.map((piece) => piece.delay)).size).toBeGreaterThan(10);
  });

  it('is a real throw: each piece rises well clear of the figure, then falls back past it', () => {
    for (const piece of pieces) {
      const ys = piece.path.map((point) => point.y);
      const xs = piece.path.map((point) => point.x);
      expect(piece.path[0]).toEqual({ x: 0, y: 0 });
      expect(Math.min(...ys)).toBeLessThan(-40);
      expect(ys[ys.length - 1]).toBeGreaterThan(200);
      expect(Math.max(...xs.map(Math.abs))).toBeLessThan(460);
      // Rises first, then falls: one turn, no wobble.
      const apex = ys.indexOf(Math.min(...ys));
      for (let i = 1; i <= apex; i += 1) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1]);
      for (let i = apex + 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    }
    // Both sides of the figure, so it reads as a burst and not a jet.
    expect(pieces.some((piece) => piece.path[piece.path.length - 1].x < -80)).toBe(true);
    expect(pieces.some((piece) => piece.path[piece.path.length - 1].x > 80)).toBe(true);
  });

  it('tumbles: each piece spins its own way', () => {
    expect(pieces.some((piece) => piece.spin < -360)).toBe(true);
    expect(pieces.some((piece) => piece.spin > 360)).toBe(true);
    expect(new Set(pieces.map((piece) => piece.flutterPhase)).size).toBe(pieces.length);
  });

  it('is over in under two seconds, so the card can leave beneath it', () => {
    expect(CLAIM_CONFETTI_MS).toBeLessThan(2000);
    expect(CLAIM_CONFETTI_MS).toBeGreaterThan(1400);
  });
});

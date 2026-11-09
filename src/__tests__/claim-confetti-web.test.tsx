import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAIM_CONFETTI_COLOURS, claimConfettiKeyframes } from '@/components/ClaimConfetti';

import {
  CLAIM_CONFETTI_MS,
  CLAIM_CONFETTI_TONES,
  claimConfettiPieces,
  confettiFlutter,
} from '../../ugc-mobile/lib/claim-confetti-flight/claim-confetti-flight';

describe('the claim’s confetti flight, shared with the app (ugc-mobile/lib/claim-confetti-flight)', () => {
  const pieces = claimConfettiPieces();

  it('is the same 48 pieces every time, in five tones and three shapes, over in under two seconds', () => {
    expect(pieces).toHaveLength(48);
    expect(claimConfettiPieces()).toEqual(pieces);
    expect(new Set(pieces.map((piece) => piece.tone))).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(new Set(pieces.map((piece) => piece.shape))).toEqual(new Set(['strip', 'chip', 'dot']));
    expect(CLAIM_CONFETTI_MS).toBeGreaterThan(1400);
    expect(CLAIM_CONFETTI_MS).toBeLessThan(2000);
  });

  it('is a burst out of the figure: up and to both sides, then down past it', () => {
    for (const piece of pieces) {
      const ys = piece.path.map((point) => point.y);
      expect(piece.path[0]).toEqual({ x: 0, y: 0 });
      expect(Math.min(...ys)).toBeLessThan(-40);
      expect(ys.at(-1)).toBeGreaterThan(200);
      expect(piece.delay).toBeLessThan(100);
    }
    expect(pieces.some((piece) => piece.path.at(-1)!.x < -80)).toBe(true);
    expect(pieces.some((piece) => piece.path.at(-1)!.x > 80)).toBe(true);
  });
});

describe('the confetti on the web (Web Animations API)', () => {
  const piece = claimConfettiPieces()[7];

  it('plays each piece’s sampled flight as transforms and opacity, joined linearly', () => {
    const frames = claimConfettiKeyframes(piece);
    expect(frames.move).toHaveLength(piece.path.length);
    expect(frames.move[0]).toEqual({ offset: 0, transform: 'translate(0px, 0px)' });
    const last = piece.path.at(-1)!;
    expect(frames.move.at(-1)).toEqual({ offset: 1, transform: `translate(${last.x}px, ${last.y}px)` });
    expect(frames.fade).toEqual([{ offset: 0, opacity: 0 }, { offset: 0.04, opacity: 1 }, { offset: 0.7, opacity: 1 }, { offset: 1, opacity: 0 }]);
    expect(frames.tumble).toHaveLength(9);
    expect(frames.tumble[0].transform).toMatch(/^rotate\(0deg\) scaleX\(/);
    expect(frames.tumble.at(-1)!.transform).toBe(`rotate(${piece.spin}deg) scaleX(${Math.round(confettiFlutter(piece)[8] * 1000) / 1000})`);
  });

  it('paints the five tones in the app’s light palette, which the card is drawn in', () => {
    const theme = readFileSync(path.join(process.cwd(), 'ugc-mobile/lib/theme.ts'), 'utf8');
    const light = theme.slice(theme.indexOf('const lightColors'), theme.indexOf('export const mediaColors'));
    for (const name of CLAIM_CONFETTI_TONES) {
      const value = new RegExp(`\\b${name}: '([^']+)'`).exec(light)?.[1];
      expect(value?.toLowerCase(), name).toBe(CLAIM_CONFETTI_COLOURS[name]);
    }
  });
});

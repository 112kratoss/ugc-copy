import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPEAR_TOTAL,
  CALM_LETTER_AT,
  CALM_LETTER_READ_AT,
  dustTile,
  DUST_END_AT,
  ENTER,
  FADE_OUT,
  grainAt,
  HOLD,
  INTRO_LETTER,
  INTRO_LETTER_SPOKEN,
  INTRO_PIECES,
  INTRO_WORDS,
  INTRO_WORDS_SPOKEN,
  introBlockWidth,
  introLines,
  introTypeScale,
  interpolate,
  LETTER_ACTION,
  LETTER_AT,
  LETTER_BODY,
  LETTER_HEAD,
  LETTER_READ_AT,
  LETTER_SIGN,
  LETTER_START,
  LETTER_TOTAL,
  LINE_GAP,
  NOTE_GAP,
  NOTE_LINE,
  NOTE_SIZE,
  NOTE_WRITE,
  scatter,
  share,
  SNAP,
  SNAP_AT,
  TILE,
  WORD_GAP,
  WORD_IN,
  WORD_LINE,
  WORD_SIZE,
  WORD_TRACKING,
  wordFrame,
} from '@/lib/first-sign-up-intro-timeline';

// The web's first sign-up intro plays the app's intro (#725): its words, its
// timeline and its dust. The app's component is read as text, as the root
// suite cannot load React Native.
const APP_INTRO = readFileSync(path.join(process.cwd(), 'ugc-mobile/components/first-open-intro.tsx'), 'utf8');

function appNumber(name: string): number {
  const match = new RegExp(`const ${name} = (-?[\\d.]+);`).exec(APP_INTRO);
  if (!match) throw new Error(`${name} not found in the app's intro`);
  return Number(match[1]);
}

function appPair(name: string): number[] {
  const match = new RegExp(`const ${name} = \\[(\\d+), (\\d+)\\];`).exec(APP_INTRO);
  if (!match) throw new Error(`${name} not found in the app's intro`);
  return [Number(match[1]), Number(match[2])];
}

function appStyle(name: string, property: string): number {
  const block = new RegExp(`const ${name}: TextStyle = \\{([^}]*)\\}`).exec(APP_INTRO)?.[1] ?? '';
  const match = new RegExp(`${property}: (-?[\\d.]+)`).exec(block);
  if (!match) throw new Error(`${name}.${property} not found in the app's intro`);
  return Number(match[1]);
}

describe('the app\'s intro, on the web', () => {
  it('keeps the app\'s timeline', () => {
    expect({ WORD_IN, WORD_GAP, NOTE_WRITE, HOLD, SNAP, FADE_OUT, ENTER, LETTER_START, LETTER_TOTAL }).toEqual({
      WORD_IN: appNumber('WORD_IN'),
      WORD_GAP: appNumber('WORD_GAP'),
      NOTE_WRITE: appNumber('NOTE_WRITE'),
      HOLD: appNumber('HOLD'),
      SNAP: appNumber('SNAP'),
      FADE_OUT: appNumber('FADE_OUT'),
      ENTER: appNumber('ENTER'),
      LETTER_START: appNumber('LETTER_START'),
      LETTER_TOTAL: appNumber('LETTER_TOTAL'),
    });
    expect([...LETTER_HEAD]).toEqual(appPair('LETTER_HEAD'));
    expect([...LETTER_BODY]).toEqual(appPair('LETTER_BODY'));
    expect([...LETTER_SIGN]).toEqual(appPair('LETTER_SIGN'));
    expect([...LETTER_ACTION]).toEqual(appPair('LETTER_ACTION'));
  });

  it('keeps the app\'s sizes, tile and spacing at type scale 1', () => {
    expect({ WORD_SIZE, WORD_LINE, WORD_TRACKING, NOTE_SIZE, NOTE_LINE }).toEqual({
      WORD_SIZE: appStyle('WORD_STYLE', 'fontSize'),
      WORD_LINE: appStyle('WORD_STYLE', 'lineHeight'),
      WORD_TRACKING: appStyle('WORD_STYLE', 'letterSpacing'),
      NOTE_SIZE: appStyle('NOTE_STYLE', 'fontSize'),
      NOTE_LINE: appStyle('NOTE_STYLE', 'lineHeight'),
    });
    expect(TILE).toBe(appNumber('TILE'));
    expect(NOTE_GAP).toBe(appNumber('NOTE_GAP'));
    expect(APP_INTRO).toContain(`gap: ${LINE_GAP}, paddingRight`);
  });

  it('says the app\'s words and notes, in its tones', () => {
    for (const word of INTRO_WORDS) {
      const tone = { primary: 'primary', image: 'image', motion: 'motion' }[word.tone];
      expect(APP_INTRO).toContain(`{ lead: '${word.lead}', note: '${word.note}', tone: '${tone}' }`);
    }
    expect(INTRO_WORDS_SPOKEN).toBe('Create anything. Share the magic. Earn as it grows.');
  });

  it('says the app\'s note, thanking someone for joining Magic Booklet', () => {
    expect(APP_INTRO).toContain(`headline: '${INTRO_LETTER.headline}'`);
    expect(APP_INTRO).toContain(`'${INTRO_LETTER.bodyAfter}'`);
    expect(APP_INTRO).toContain(`action: '${INTRO_LETTER.action}'`);
    expect(INTRO_LETTER_SPOKEN).toBe(
      'Thank you for joining Magic Booklet. We’re building a kind, creative community where anyone can make something amazing, share it, and earn when others build on it. We’re so glad you’re here. Magic Booklet.',
    );
  });

  it('uses the app\'s throw for every tile', () => {
    expect(APP_INTRO).toContain('const begin = Math.min(0.62, 0.02 + sweepDelay + sweep * 0.42 + a * 0.12);');
    expect(APP_INTRO).toContain('driftX: 30 + a * a * 220,');
    expect(APP_INTRO).toContain('driftY: -(18 + b * b * 170),');
    expect(APP_INTRO).toContain('spin: (c - 0.5) * 260,');
    expect(APP_INTRO).toContain('seedBase={wordIndex} sweepDelay={wordIndex * 0.07}');
    expect(APP_INTRO).toContain('seedBase={wordIndex + 10} sweepDelay={0.18 + wordIndex * 0.07}');
  });
});

describe('the timeline', () => {
  it('runs the words, the hold, the dust and the note in the app\'s order', () => {
    expect(APPEAR_TOTAL).toBe(2800);
    expect(SNAP_AT).toBe(3200);
    // The note comes in while the dust is still blowing.
    expect(LETTER_AT).toBe(4740);
    expect(LETTER_AT).toBeLessThan(DUST_END_AT);
    expect(DUST_END_AT).toBe(6000);
    expect(LETTER_READ_AT).toBe(7290);
  });

  it('brings each word in a line at a time, rising into place, then writes its note', () => {
    expect(wordFrame(0, 0, false)).toEqual({ opacity: 0, rise: 18, written: 0, noteOpacity: 1 });
    expect(wordFrame(0, WORD_IN / 2, false).opacity).toBeCloseTo(0.5);
    expect(wordFrame(0, WORD_IN / 2, false).rise).toBeCloseTo(9);
    expect(wordFrame(0, WORD_IN, false)).toMatchObject({ opacity: 1, rise: 0 });
    // The second line starts a gap later.
    expect(wordFrame(1, WORD_GAP - 1, false).opacity).toBe(0);
    expect(wordFrame(1, WORD_GAP + WORD_IN, false).opacity).toBe(1);
    // A note is written once its word has nearly landed, over NOTE_WRITE.
    const noteStart = WORD_IN * 0.7;
    expect(wordFrame(0, noteStart, false).written).toBe(0);
    expect(wordFrame(0, noteStart + NOTE_WRITE / 2, false).written).toBeCloseTo(0.5);
    expect(wordFrame(2, APPEAR_TOTAL, false).written).toBe(1);
  });

  it('under reduced motion, fades the words in together with no rise or writing, then out as the note comes', () => {
    for (const index of [0, 1, 2]) {
      expect(wordFrame(index, 0, true)).toEqual({ opacity: 0, rise: 0, written: 1, noteOpacity: 0 });
      expect(wordFrame(index, 400, true)).toEqual({ opacity: 1, rise: 0, written: 1, noteOpacity: 1 });
      expect(wordFrame(index, CALM_LETTER_AT, true).opacity).toBe(1);
      expect(wordFrame(index, CALM_LETTER_AT + 400, true).opacity).toBe(0);
    }
    expect(CALM_LETTER_AT).toBe(1700);
    expect(CALM_LETTER_READ_AT).toBe(2100);
  });

  it('interpolates through its points and clamps at both ends', () => {
    expect(share(5, 0, 10)).toBe(0.5);
    expect(share(-1, 0, 10)).toBe(0);
    expect(share(11, 0, 10)).toBe(1);
    expect(interpolate(0.3, [0, 0.3, 1], [1, 0.45, 0.15])).toBeCloseTo(0.45);
    expect(interpolate(0.65, [0, 0.3, 1], [1, 0.45, 0.15])).toBeCloseTo(0.3);
    expect(interpolate(2, [0, 1], [0, 10])).toBe(10);
  });
});

describe('the layout', () => {
  // Rough widths of the words and notes at type scale 1, as measured in Bricolage and Caveat.
  const words = [176, 148, 118];
  const notes = [96, 102, 122];
  const block = introBlockWidth(words, notes);

  it('draws the app\'s sizes on a phone', () => {
    expect(introTypeScale({ width: 390, height: 844 }, block)).toBe(1);
  });

  it('draws the words larger on a big screen, by its height', () => {
    expect(introTypeScale({ width: 1440, height: 900 }, block)).toBe(1.5);
    expect(introTypeScale({ width: 1280, height: 720 }, block)).toBeCloseTo(1.2);
    expect(introTypeScale({ width: 2560, height: 1440 }, block)).toBe(1.5);
  });

  it('shrinks the words to fit across a narrow screen', () => {
    const scale = introTypeScale({ width: 320, height: 568 }, block);
    expect(scale).toBeLessThan(1);
    expect(block * scale).toBeLessThanOrEqual(320 - 48);
  });

  it('centres the words and their notes together, each note a little low beside its word', () => {
    const lines = introLines({ width: 390, height: 844 }, 1, words, notes);
    const right = Math.max(...lines.map((line, index) => line.noteX + notes[index]));
    expect(lines[0].wordX).toBeCloseTo(390 - right);
    expect(new Set(lines.map((line) => line.wordX)).size).toBe(1);
    expect(lines[1].wordY - lines[0].wordY).toBe(WORD_LINE + LINE_GAP);
    expect(lines[0].noteX).toBe(lines[0].wordX + words[0] + NOTE_GAP);
    expect(lines[0].noteY - lines[0].wordY).toBeCloseTo(WORD_LINE * 0.46);
    const top = lines[0].wordY;
    const bottom = lines[2].wordY + WORD_LINE;
    expect(top).toBeCloseTo(844 - bottom);
  });
});

describe('the dust', () => {
  it('cuts each word and each note, with the app\'s seeds and sweep', () => {
    expect(INTRO_PIECES.map((piece) => [piece.text, piece.seedBase, piece.sweepDelay])).toEqual([
      ['Create', 0, 0],
      ['anything', 10, 0.18],
      ['Share', 1, 0.07],
      ['the magic', 11, 0.25],
      ['Earn', 2, 0.14],
      ['as it grows', 12, 0.32],
    ].map(([text, seed, delay]) => [text, seed, expect.closeTo(delay as number, 10)]));
  });

  it('throws the same tile the same way every time', () => {
    expect(dustTile(3, 2, 20, 1, 0.07)).toEqual(dustTile(3, 2, 20, 1, 0.07));
    expect(scatter(42)).toBe(scatter(42));
    expect(scatter(42)).toBeGreaterThanOrEqual(0);
    expect(scatter(42)).toBeLessThan(1);
  });

  it('sweeps from the left: the right of a word goes later, and every tile has gone by the end', () => {
    const cols = 24;
    const meanBegin = (col: number) => {
      const tiles = Array.from({ length: 8 }, (_, row) => dustTile(col, row, cols, 0, 0));
      return tiles.reduce((sum, tile) => sum + tile.begin, 0) / tiles.length;
    };
    expect(meanBegin(0)).toBeLessThan(meanBegin(12));
    expect(meanBegin(12)).toBeLessThan(meanBegin(23));
    for (const piece of INTRO_PIECES) {
      for (let col = 0; col < cols; col += 1) {
        const tile = dustTile(col, 3, cols, piece.seedBase, piece.sweepDelay);
        expect(tile.begin).toBeLessThanOrEqual(0.62);
        expect(tile.end).toBeLessThanOrEqual(1);
        expect(tile.end).toBeGreaterThan(tile.begin);
        expect(grainAt(tile, 1)).toBeNull();
      }
    }
  });

  it('starts each grain as part of the word, then carries it up and to the right, shrinking and fading', () => {
    const tile = dustTile(5, 1, 20, 0, 0);
    const atRest = grainAt(tile, 0)!;
    expect(atRest).toMatchObject({ opacity: 1, rotate: 0, scale: 1 });
    expect(Math.abs(atRest.x) + Math.abs(atRest.y)).toBe(0);
    const early = grainAt(tile, tile.begin + (tile.end - tile.begin) * 0.3)!;
    const late = grainAt(tile, tile.begin + (tile.end - tile.begin) * 0.9)!;
    expect(early.x).toBeGreaterThan(0);
    expect(early.y).toBeLessThan(0);
    expect(late.x).toBeGreaterThan(early.x);
    expect(late.y).toBeLessThan(early.y);
    expect(early.scale).toBeCloseTo(0.45);
    expect(late.scale).toBeLessThan(early.scale);
    expect(late.opacity).toBeLessThan(early.opacity);
    // Slow to leave, quicker as the wind takes it.
    const half = grainAt(tile, tile.begin + (tile.end - tile.begin) * 0.5)!;
    expect(half.x).toBeCloseTo(tile.driftX * 0.5 ** 1.5);
    expect(half.y).toBeCloseTo(tile.driftY * 0.25);
  });
});

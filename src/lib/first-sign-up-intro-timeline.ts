/**
 * The first sign-up intro's timeline, layout and dust as plain numbers, for
 * `src/components/onboarding/FirstSignUpIntro.tsx` to draw. Free of React and
 * the DOM, so every step is unit tested.
 *
 * The timings, words and sizes are the app's intro
 * (`ugc-mobile/components/first-open-intro.tsx`), which the tests read to keep
 * the two in step. Sizes are in CSS px at a type scale of 1, the app's points;
 * a large screen draws them bigger (`introTypeScale`).
 */

export type IntroTone = 'primary' | 'image' | 'motion';

/** Each line: the keyword, big and in its tool's colour, and the note written beside it. */
export const INTRO_WORDS: ReadonlyArray<{ lead: string; note: string; tone: IntroTone }> = [
  { lead: 'Create', note: 'anything', tone: 'primary' },
  { lead: 'Share', note: 'the magic', tone: 'image' },
  { lead: 'Earn', note: 'as it grows', tone: 'motion' },
];

/** What a screen reader reads for the words, as one item. */
export const INTRO_WORDS_SPOKEN = INTRO_WORDS.map((word) => `${word.lead} ${word.note}.`).join(' ');

/** The note from the team. The web spells the name in two words (since #697); the app says "Magicbooklet". */
export const INTRO_LETTER = {
  headline: 'A note from the team',
  bodyBefore: 'Thank you for joining ',
  bodyAfter:
    '. We’re building a kind, creative community where anyone can make something amazing, share it, and earn when others build on it. We’re so glad you’re here.',
  /** The name, drawn in the logo's two colours: coral, then lavender. */
  name: ['Magic', 'Booklet'] as const,
  action: 'Continue',
};

/** The note's paragraph and signature, as a screen reader reads them (the headline names the note). */
export const INTRO_LETTER_SPOKEN = `${INTRO_LETTER.bodyBefore}${INTRO_LETTER.name.join(' ')}${INTRO_LETTER.bodyAfter} ${INTRO_LETTER.name.join(' ')}.`;

// ---------- the app's timeline (ms) ----------

export const WORD_IN = 750; // each word's arrival
export const WORD_GAP = 700; // between one word starting and the next
export const NOTE_WRITE = 650; // a note being written, once its word has landed
export const HOLD = 400; // everything on screen before the dust
export const SNAP = 2800; // the dust
export const FADE_OUT = 380; // the intro lifting off the page beneath
export const ENTER = 460; // the intro's ground coming in over a page already on screen
export const LETTER_START = 0.55; // how far into the dust the note starts to come in
// The note's own timeline: headline, paragraph, the signature written in, the button.
export const LETTER_HEAD = [0, 500] as const;
export const LETTER_BODY = [300, 1100] as const;
export const LETTER_SIGN = [1250, 2150] as const;
export const LETTER_ACTION = [2150, 2550] as const;
export const LETTER_TOTAL = 2550;

export const APPEAR_TOTAL = WORD_GAP * (INTRO_WORDS.length - 1) + WORD_IN + NOTE_WRITE;
/** From the start of the timeline: the dust starts, the note comes in, the dust has gone, Continue can be pressed. */
export const SNAP_AT = APPEAR_TOTAL + HOLD;
export const LETTER_AT = SNAP_AT + Math.round(SNAP * LETTER_START);
export const DUST_END_AT = SNAP_AT + SNAP;
export const LETTER_READ_AT = LETTER_AT + LETTER_TOTAL;

// Reduced motion, as the app's Reduce Motion: the words fade in together and
// stay, then cross-fade to the note, which arrives whole. No dust, no writing.
export const CALM_FADE = 400;
export const CALM_ENTER = 200;
export const CALM_LETTER_AT = CALM_FADE + HOLD + 900;
export const CALM_LETTER_READ_AT = CALM_LETTER_AT + CALM_FADE;

// ---------- the app's sizes (CSS px at type scale 1) ----------

export const WORD_SIZE = 54;
export const WORD_LINE = 62;
export const WORD_TRACKING = -0.8;
export const WORD_WEIGHT = 800;
export const NOTE_SIZE = 27;
export const NOTE_LINE = 32;
export const NOTE_WEIGHT = 700;
/** Between a word and its note. */
export const NOTE_GAP = 10;
/** Between one line and the next. */
export const LINE_GAP = 4;
/** The note sits a little low: its top this far down its word's line. */
export const NOTE_DROP = 0.46;
/** How far below its place a word starts its arrival. */
export const RISE = 18;
/** A dust tile's edge. The app's 8 keeps the grains near its own count. */
export const TILE = 8;

// ---------- timing helpers ----------

/** How far `value` is through `from`..`to`, clamped to 0..1. */
export function share(value: number, from: number, to: number): number {
  if (to <= from) return value >= to ? 1 : 0;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

/** Piecewise-linear interpolation through `points` (inputs ascending), clamped at both ends. */
export function interpolate(value: number, inputs: readonly number[], outputs: readonly number[]): number {
  if (value <= inputs[0]) return outputs[0];
  for (let index = 1; index < inputs.length; index += 1) {
    if (value <= inputs[index]) {
      const t = share(value, inputs[index - 1], inputs[index]);
      return outputs[index - 1] + (outputs[index] - outputs[index - 1]) * t;
    }
  }
  return outputs[outputs.length - 1];
}

export const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
/** The same curves for the Web Animations API. */
export const EASE_OUT_QUAD_CSS = 'cubic-bezier(0.5, 1, 0.89, 1)';
export const EASE_OUT_CUBIC_CSS = 'cubic-bezier(0.33, 1, 0.68, 1)';

export type WordFrame = {
  /** The keyword's opacity. */
  opacity: number;
  /** How far below its place the keyword still is, in px at type scale 1. */
  rise: number;
  /** How much of the note is written, left to right (0 to 1). */
  written: number;
  noteOpacity: number;
};

/**
 * One line of the words at `elapsed` ms into the timeline. A word fades in as
 * it rises into place; its note is written in once the word has nearly
 * landed. Under reduced motion every line fades in together, stays, and fades
 * out as the note comes in, notes whole.
 */
export function wordFrame(index: number, elapsed: number, calm: boolean): WordFrame {
  const start = WORD_GAP * index;
  if (calm) {
    const appear = elapsed < CALM_LETTER_AT
      ? easeOutQuad(share(elapsed, 0, CALM_FADE))
      : 1 - easeOutQuad(share(elapsed, CALM_LETTER_AT, CALM_LETTER_AT + CALM_FADE));
    // The app's windows over a quick 0-to-1: the lines all but together.
    const opacity = share(appear * APPEAR_TOTAL, start, start + WORD_IN);
    return { opacity, rise: 0, written: 1, noteOpacity: opacity };
  }
  const arrived = share(elapsed, start, start + WORD_IN);
  const noteStart = start + WORD_IN * 0.7;
  return {
    opacity: arrived,
    rise: RISE * (1 - arrived),
    written: share(elapsed, noteStart, noteStart + NOTE_WRITE),
    noteOpacity: 1,
  };
}

// ---------- layout ----------

/** Room kept on each side of the words on a narrow screen. */
export const INTRO_GUTTER = 24;
/** From this width the words grow with the window's height, up to `INTRO_MAX_SCALE`. */
export const INTRO_WIDE_FROM = 768;
export const INTRO_MAX_SCALE = 1.5;
/** A window this many px tall per unit of scale: 900 tall draws the words at 1.5. */
export const INTRO_HEIGHT_PER_SCALE = 600;
export const INTRO_MIN_SCALE = 0.6;

/** The widest line at type scale 1: a word, the gap and its note. */
export function introBlockWidth(wordWidths: readonly number[], noteWidths: readonly number[], scale = 1): number {
  return Math.max(...wordWidths.map((width, index) => width + NOTE_GAP * scale + noteWidths[index]));
}

/**
 * The words' type scale for a window: the app's sizes on a phone, larger on a
 * big screen, and smaller where the lines would not fit across.
 */
export function introTypeScale(viewport: { width: number; height: number }, blockWidthAtOne: number): number {
  const fits = (viewport.width - 2 * INTRO_GUTTER) / Math.max(1, blockWidthAtOne);
  const wanted = viewport.width >= INTRO_WIDE_FROM
    ? Math.min(INTRO_MAX_SCALE, Math.max(1, viewport.height / INTRO_HEIGHT_PER_SCALE))
    : 1;
  return Math.max(INTRO_MIN_SCALE, Math.min(wanted, fits));
}

export type IntroLine = {
  /** The top-left of the keyword's line box. */
  wordX: number;
  wordY: number;
  /** The top-left of the note's line box. */
  noteX: number;
  noteY: number;
};

/**
 * Where each line goes: left-aligned to each other, the block centred on the
 * words and their notes together (the notes hang off the right), each note a
 * little low beside its word. Widths are at `scale`.
 */
export function introLines(
  viewport: { width: number; height: number },
  scale: number,
  wordWidths: readonly number[],
  noteWidths: readonly number[],
): IntroLine[] {
  const lineHeight = WORD_LINE * scale;
  const gap = LINE_GAP * scale;
  const blockWidth = introBlockWidth(wordWidths, noteWidths, scale);
  const blockHeight = wordWidths.length * lineHeight + (wordWidths.length - 1) * gap;
  const left = (viewport.width - blockWidth) / 2;
  const top = (viewport.height - blockHeight) / 2;
  return wordWidths.map((width, index) => {
    const wordY = top + index * (lineHeight + gap);
    return {
      wordX: left,
      wordY,
      noteX: left + width + NOTE_GAP * scale,
      noteY: wordY + lineHeight * NOTE_DROP,
    };
  });
}

// ---------- the dust ----------

/** Each piece that turns to dust: the three words and their notes, with the app's seeds and sweep. */
export type IntroPiece = { kind: 'word' | 'note'; index: number; text: string; seedBase: number; sweepDelay: number };

export const INTRO_PIECES: readonly IntroPiece[] = INTRO_WORDS.flatMap((word, index) => [
  { kind: 'word' as const, index, text: word.lead, seedBase: index, sweepDelay: index * 0.07 },
  { kind: 'note' as const, index, text: word.note, seedBase: index + 10, sweepDelay: 0.18 + index * 0.07 },
]);

/** Repeatable scatter: the same tile always gets the same throw. */
export function scatter(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export type DustTile = {
  col: number;
  row: number;
  /** Where in the dust (0 to 1) the tile starts to go, and where it has gone. */
  begin: number;
  end: number;
  /** How far it is carried by the end, at type scale 1: right, and up (negative). */
  driftX: number;
  driftY: number;
  /** Its turn by the end, in degrees. */
  spin: number;
};

/** The app's throw for a tile of a piece cut into `cols` × `rows`. */
export function dustTile(col: number, row: number, cols: number, seedBase: number, sweepDelay: number): DustTile {
  const seed = seedBase * 10000 + row * 100 + col;
  const a = scatter(seed);
  const b = scatter(seed + 0.5);
  const c = scatter(seed + 0.25);
  // A sweep from the left of each piece, the lower lines a beat later, with
  // scatter so the edge of the dust is ragged.
  const sweep = col / cols;
  const begin = Math.min(0.62, 0.02 + sweepDelay + sweep * 0.42 + a * 0.12);
  const span = 0.3 + b * 0.12;
  return {
    col,
    row,
    begin,
    end: Math.min(1, begin + span),
    // Squared, so most grains settle close by and a few are carried far.
    driftX: 30 + a * a * 220,
    driftY: -(18 + b * b * 170),
    spin: (c - 0.5) * 260,
  };
}

export type Grain = {
  opacity: number;
  /** Offset from the tile's place, in px at type scale 1. */
  x: number;
  y: number;
  /** Radians. */
  rotate: number;
  scale: number;
};

/**
 * A tile `snap` (0 to 1) into the dust: slow to leave and quicker as the wind
 * takes it (across at t^1.5, up at t^2, the app's curves), turning, broken
 * down to a grain within the first third, and dimmed early so it reads as ash.
 * Null once it has gone.
 */
export function grainAt(tile: DustTile, snap: number): Grain | null {
  const t = share(snap, tile.begin, tile.end);
  if (t >= 1) return null;
  return {
    opacity: interpolate(t, [0, 0.15, 0.6, 1], [1, 0.8, 0.35, 0]),
    x: t ** 1.5 * tile.driftX,
    y: t ** 2 * tile.driftY,
    rotate: (t * tile.spin * Math.PI) / 180,
    scale: interpolate(t, [0, 0.3, 1], [1, 0.45, 0.15]),
  };
}

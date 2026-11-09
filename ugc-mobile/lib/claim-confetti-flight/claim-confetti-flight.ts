/**
 * The welcome claim's confetti flight, in one copy the app and the web share
 * by relative import (owner, 2026-11-09: "confetti ... in many many apps, a
 * similar premium feel which gives the user a satisfaction of gaining
 * something"). Premium here means one palette, not a rainbow: thin strips,
 * small chips and a few dots in the brand's coral, gold, deep orange, peach and
 * white, thrown up and out of the figure in one burst, then falling under
 * gravity with air drag, each piece tumbling on its own phase, fading as it
 * lands.
 *
 * The flight is computed once (seeded, the same every time) as a few sampled
 * points per piece; each client plays it as transforms and opacity only: the
 * app on React Native's native driver, the web with the Web Animations API.
 * Both interpolate linearly between the samples, so the two draw one flight.
 *
 * Metro, Next.js and Vitest all compile this file, so it stays free of React
 * Native, Expo and Node imports (see this folder's tsconfig.json).
 */
const PIECE_COUNT = 48;
/** How many points of each flight are sampled; the clients interpolate between them. */
const FLIGHT_SAMPLES = 10;
const GRAVITY = 1300;
/** Velocity kept per 1/60 s: the strips flutter down rather than drop. */
const DRAG = 0.97;
/** A burst, not a cascade: every piece is away within a tenth of a second. */
const MAX_DELAY_MS = 90;
const MIN_FLIGHT_MS = 1400;
const MAX_FLIGHT_MS = 1900;

/** Where the burst starts, in the window's points or pixels. */
export type ClaimOrigin = { x: number; y: number };

export type ConfettiPiece = {
  shape: 'strip' | 'chip' | 'dot';
  width: number;
  height: number;
  /** Its colour: an index into `CLAIM_CONFETTI_TONES`. */
  tone: number;
  /** The piece's place at even steps of its flight, relative to the origin. */
  path: Array<{ x: number; y: number }>;
  /** Full turns about its own axis over the flight, in degrees. */
  spin: number;
  /** Where in its tumble the piece starts, 0..1. */
  flutterPhase: number;
  delay: number;
  duration: number;
};

/**
 * The five tones, by the app's theme names: coral, gold, deep orange, peach
 * and white, all from the light palette the card is drawn in. The app reads
 * each from its theme hook; the web maps the names to the same colours.
 */
export const CLAIM_CONFETTI_TONES = [
  'primaryFill',
  'navigationCreateTop',
  'navigationCreateBottom',
  'selectedStrong',
  'surfaceInset',
] as const;

/** Seeded, so the burst is the same every time (and in tests). */
export function claimConfettiPieces(count = PIECE_COUNT, seed = 29): ConfettiPiece[] {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
  return Array.from({ length: count }, (_, index) => {
    const shape: ConfettiPiece['shape'] = index % 6 === 5 ? 'dot' : index % 3 === 0 ? 'chip' : 'strip';
    const size = shape === 'strip' ? { width: 5 + next() * 2, height: 12 + next() * 6 }
      : shape === 'chip' ? { width: 7 + next() * 3, height: 7 + next() * 3 }
        : { width: 6, height: 6 };
    // Up and out in a fan, straight up ± 50°, fast enough that every piece
    // clears the card before it falls back past it.
    const angle = (-90 + (next() - 0.5) * 100) * (Math.PI / 180);
    const speed = 640 + next() * 300;
    const duration = Math.round(MIN_FLIGHT_MS + next() * (MAX_FLIGHT_MS - MIN_FLIGHT_MS));
    return {
      shape,
      width: Math.round(size.width),
      height: Math.round(size.height),
      tone: index % CLAIM_CONFETTI_TONES.length,
      path: flight(Math.cos(angle) * speed, Math.sin(angle) * speed, duration),
      spin: Math.round((next() - 0.5) * 1440),
      flutterPhase: next(),
      delay: Math.round(next() * MAX_DELAY_MS),
      duration,
    };
  });
}

/** Where a piece thrown at (vx, vy) points per second is at each sampled step of its flight. */
function flight(vx: number, vy: number, durationMs: number) {
  const step = 1 / 60;
  const steps = Math.round((durationMs / 1000) / step);
  const path: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  let dx = vx;
  let dy = vy;
  for (let i = 1; i <= steps; i += 1) {
    dy += GRAVITY * step;
    dx *= DRAG;
    dy *= DRAG;
    x += dx * step;
    y += dy * step;
    if (i % Math.ceil(steps / (FLIGHT_SAMPLES - 1)) === 0 && path.length < FLIGHT_SAMPLES - 1) {
      path.push({ x: Math.round(x), y: Math.round(y) });
    }
  }
  path.push({ x: Math.round(x), y: Math.round(y) });
  return path;
}

/** From the burst to the last piece gone. */
export const CLAIM_CONFETTI_MS = Math.max(...claimConfettiPieces().map((piece) => piece.delay + piece.duration));

/** The steps of a piece's flight, 0..1, at which its sampled points fall. */
export function confettiPathSteps(piece: Pick<ConfettiPiece, 'path'>): number[] {
  return piece.path.map((_, step) => step / (piece.path.length - 1));
}

/** The steps of the tumble: a piece turns edge-on and back four times over its flight. */
export const CONFETTI_FLUTTER_STEPS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** The piece's width at each tumble step, as a share of its own (0.15 edge-on, 1 face-on). */
export function confettiFlutter(piece: Pick<ConfettiPiece, 'flutterPhase'>): number[] {
  return CONFETTI_FLUTTER_STEPS.map((at) => 0.15 + 0.85 * Math.abs(Math.cos((at + piece.flutterPhase) * Math.PI * 4)));
}

/** A piece's opacity over its flight: in at once, held, fading as it lands. */
export const CONFETTI_OPACITY_STEPS = [0, 0.04, 0.7, 1];
export const CONFETTI_OPACITY = [0, 1, 1, 0];

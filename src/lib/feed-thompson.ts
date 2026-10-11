/**
 * Deterministic sampling for the feed's Thompson-sampled cold-start slot.
 *
 * Everything here is driven by one 32-bit seed (`feed_sessions.random_seed`),
 * so a ranked session can be replayed exactly: the same seed and the same
 * candidates give the same draws. `Math.random` is never used.
 */

/** A uniform source on [0, 1). */
export type RandomSource = () => number;

/**
 * mulberry32: a small, fast 32-bit PRNG. Plenty for picking one exploration
 * slot per ranking; not for anything security-related. The state is kept in
 * int32 range (`| 0`), so the stream never loses precision however long it runs.
 */
export function mulberry32(seed: number): RandomSource {
  let state = Number.isFinite(seed) ? seed | 0 : 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function assertShape(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number above 0, got ${value}`);
  }
}

function sampleStandardNormal(random: RandomSource) {
  // Box–Muller. `1 − u` is in (0, 1], so the logarithm stays finite.
  const radius = Math.sqrt(-2 * Math.log(1 - random()));
  return radius * Math.cos(2 * Math.PI * random());
}

/**
 * Gamma(shape, 1) by Marsaglia and Tsang (2000). For shape < 1 it samples
 * Gamma(shape + 1) and scales by U^(1/shape), the paper's boost for small shapes.
 */
export function sampleGamma(shape: number, random: RandomSource): number {
  assertShape('shape', shape);
  if (shape < 1) {
    // 1 − u is in (0, 1], so the boost never multiplies by an exact 0.
    return sampleGamma(shape + 1, random) * Math.pow(1 - random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Beta(alpha, beta) as X / (X + Y) with X ~ Gamma(alpha), Y ~ Gamma(beta).
 * The result is kept inside the open interval (0, 1): with very small shapes a
 * gamma draw can underflow to 0, and a posterior mean of exactly 0 or 1 is not
 * a value the slot should ever act on.
 */
export function sampleBeta(alpha: number, beta: number, random: RandomSource): number {
  assertShape('alpha', alpha);
  assertShape('beta', beta);
  const x = sampleGamma(alpha, random);
  const y = sampleGamma(beta, random);
  const draw = x / (x + y);
  if (!Number.isFinite(draw)) return alpha / (alpha + beta);
  return Math.min(1 - Number.EPSILON / 2, Math.max(Number.MIN_VALUE, draw));
}

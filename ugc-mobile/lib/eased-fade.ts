/**
 * One eased fade, shared by every shade over full-bleed media — the reel's top
 * shade and the bands around a letterboxed picture — so they fall off the same
 * way where they overlap.
 *
 * A straight-line fade ends in a visible kink: the eye reads the change of slope
 * as an edge (a Mach band). This curve drops fastest where the shade is darkest
 * and runs out almost flat, as [position along the fade, share of the starting
 * opacity].
 */
const EASED_FADE: readonly (readonly [number, number])[] = [
  [0, 1], [0.19, 0.738], [0.34, 0.541], [0.47, 0.382], [0.565, 0.278], [0.65, 0.194],
  [0.73, 0.126], [0.802, 0.075], [0.861, 0.042], [0.91, 0.021], [0.952, 0.008], [0.982, 0.002], [1, 0],
];

export interface FadeStop {
  /** Position along the fade, 0 at the dark end and 1 where it has run out. */
  at: number;
  alpha: number;
}

/** The eased fade from `startAlpha` down to nothing. */
export function easedFade(startAlpha: number): FadeStop[] {
  return EASED_FADE.map(([at, share]) => ({ at, alpha: startAlpha * share }));
}

/** A `#rrggbb` colour at `alpha`, as the 8-digit hex gradients take. */
export function hexWithAlpha(hex: string, alpha: number) {
  const clamped = Math.min(1, Math.max(0, alpha));
  return `${hex.slice(0, 7)}${Math.round(clamped * 255).toString(16).padStart(2, '0')}`;
}

/**
 * Colour stops as a CSS linear gradient, for React Native's own gradient
 * (`experimental_backgroundImage`), with each stop's position `at` (0–1) along
 * the gradient written as a percentage.
 */
export function linearGradient(
  direction: 'to top' | 'to bottom' | 'to left' | 'to right',
  stops: readonly { color: string; at: number }[],
) {
  const list = stops.map(({ color, at }) => `${color} ${Number((at * 100).toFixed(4))}%`);
  return `linear-gradient(${direction}, ${list.join(', ')})`;
}

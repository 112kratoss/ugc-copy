/**
 * How search opens out of the control that was pressed (owner, 2026-11-14:
 * "smoothen out the animation when the search button is pressed", after iOS's
 * own Search on the home screen). Filmed on the owner's iPhone 16e, iOS's
 * Search is one motion of about 350 ms: the Search capsule grows into the
 * field, the keyboard rises in the same moment and what was under it recedes.
 * Ours was three steps, about 850 ms: the page slid in from the right, its
 * suggestions replaced a placeholder card, and only then did the keyboard rise.
 *
 * So the search screen cross-fades in over the page it opens from, the field's
 * capsule grows out of the pressed control's frame into its own, the
 * magnifier travels with it and the rest of the screen arrives around them;
 * the field takes the focus as it lands, so the keyboard follows straight on.
 * Close runs the same motion back into the control. This module is the pure
 * geometry and timing, unit-tested; `components/search-entrance.tsx` draws it.
 */

export type SearchEntranceKind = 'button' | 'field';

/** The pressed control's frame in the window, and what it looks like. */
export type SearchEntranceOrigin = {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * A round button with a magnifier in its middle (Home's, Explore's compact
   * one), or a bar drawn as the field is, magnifier and placeholder at its
   * start (Explore's): its text is already there and travels with it.
   */
  kind: SearchEntranceKind;
};

export type SearchFieldFrame = { x: number; y: number; width: number; height: number };

/**
 * Where the field's capsule and magnifier start, relative to where they rest:
 * the capsule as insets from the field's own frame (a negative inset reaches
 * outside it), the magnifier as an offset from its resting centre.
 */
export type SearchEntranceStart = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  iconX: number;
  iconY: number;
  /** Whether the field's text is on show from the start (a bar) or arrives (a button). */
  textShown: boolean;
};

/** Nothing to grow out of (a search link, Reduce Motion): the field is where it rests. */
export const SEARCH_ENTRANCE_AT_REST: SearchEntranceStart = {
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  iconX: 0,
  iconY: 0,
  textShown: true,
};

export const SEARCH_ENTRANCE = {
  /**
   * The navigator's cross-fade between the page and search (`animationDuration`,
   * iOS; Android's fade has its own). Shorter than the capsule's growth, so the
   * page has gone before the capsule lands.
   */
  fadeMs: 200,
  /**
   * The capsule's growth, started as the screen mounts: a spring with a
   * damping ratio of about 0.97, nearly there by 300 ms and at rest by about
   * 400, so it lands without a bounce. Not at the navigator's
   * `transitionStart`: that event reached JS after the cross-fade had ended
   * (simulator, production JS). Not on the navigator's transition progress:
   * iOS reports a fade's progress as 1 at once (react-native-screens runs it
   * on a UIViewPropertyAnimator its progress reader cannot follow).
   */
  spring: { stiffness: 240, damping: 30, mass: 1 },
  /**
   * The field takes taps, and the focus, once it has nearly arrived. The
   * focus waits because the keyboard's setup holds the UI thread the growth
   * runs on: focused as the growth began, the capsule sat still and then
   * jumped half-way in one frame (simulator, 2026-11-14), while the fade,
   * drawn by the render server, ran on. Taps wait because the second tap of a
   * double tap on Home's magnifier landed on the field just grown under it
   * and opened iOS's edit menu (search UX fixes 2026-11-14).
   */
  touchesAfterMs: 280,
  /**
   * Close: the same motion back into the control, quicker than the growth,
   * on a decelerating curve, so it is all but home well before its end.
   */
  exitMs: 150,
  /**
   * Close asks the navigator for the pop once the field is all but back in
   * its control (98% of the way, on the exit's curve): from the pop on, the
   * navigator draws the leaving screen as a still picture, so a shrink still
   * under way froze where it was (simulator, 2026-11-14: popped 100 ms into a
   * symmetric curve, the field stopped a third of the way back and faded out
   * beside the button; popped at its end, a dark pause showed before the
   * page came back). The cross-fade then has the control in the same place
   * on both pages.
   */
  popAfterMs: 110,
} as const;

/** An origin that can be drawn from: measured, at least partly on screen, of a usable size. */
export function usableSearchEntranceOrigin(
  origin: SearchEntranceOrigin | null | undefined,
  window: { width: number; height: number },
): SearchEntranceOrigin | null {
  if (!origin) return null;
  const { x, y, width, height } = origin;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 8 || height < 8) return null;
  if (x + width <= 0 || y + height <= 0 || x >= window.width || y >= window.height) return null;
  return origin;
}

/**
 * The field's resting frame before it is measured, from the header's own
 * numbers: under the status bar by `topGap`, after the back button and the gap
 * beside it, across to the screen's margin. Measuring corrects it.
 */
export function searchFieldRestingFrame({
  windowWidth,
  topInset,
  topGap,
  screenPadding,
  leadingWidth,
  gap,
  height,
}: {
  windowWidth: number;
  topInset: number;
  topGap: number;
  screenPadding: number;
  leadingWidth: number;
  gap: number;
  height: number;
}): SearchFieldFrame {
  const x = screenPadding + leadingWidth + gap;
  return { x, y: topInset + topGap, width: Math.max(0, windowWidth - screenPadding - x), height };
}

/**
 * Where the capsule and magnifier start for an origin. `iconSize` and
 * `iconInset` place the magnifier in the field (and in a bar, which draws it
 * the same way): `iconInset` from the capsule's start, centred across it.
 */
export function searchEntranceStart(
  origin: SearchEntranceOrigin | null,
  field: SearchFieldFrame,
  { iconSize, iconInset }: { iconSize: number; iconInset: number },
): SearchEntranceStart {
  if (!origin) return SEARCH_ENTRANCE_AT_REST;
  const restX = field.x + iconInset + iconSize / 2;
  const restY = field.y + field.height / 2;
  const fromX = origin.kind === 'field' ? origin.x + iconInset + iconSize / 2 : origin.x + origin.width / 2;
  const fromY = origin.y + origin.height / 2;
  return {
    left: origin.x - field.x,
    top: origin.y - field.y,
    right: field.x + field.width - (origin.x + origin.width),
    bottom: field.y + field.height - (origin.y + origin.height),
    iconX: fromX - restX,
    iconY: fromY - restY,
    textShown: origin.kind === 'field',
  };
}

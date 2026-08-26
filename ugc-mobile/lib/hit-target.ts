/**
 * Minimum hit regions, from Apple's UI Design Dos and Don'ts.
 *
 * The rule is about the region that responds to a tap, not about how big the
 * control looks: "a button needs a hit region of at least 44x44 pt ... so that
 * people can select it easily". A byline that reads as one line of text can
 * stay one line of text and still answer to a 44pt reach, which is why the
 * short rows in this app are corrected with `hitSlop` rather than by growing
 * them — padding a creator handle out to 44pt would change the density of
 * every feed card to satisfy a rule that never asked for it.
 */
export const MIN_HIT_TARGET_PT = 44;

/**
 * Vertical slop that lifts a control's hit region to {@link MIN_HIT_TARGET_PT}
 * without changing its laid-out height.
 *
 * Split evenly above and below so the reach grows symmetrically around the
 * control — slop applied to one side only makes the target drift off-centre
 * from the thing it looks like. Rounded up, since a hit region half a point
 * short is still short.
 *
 * Returns zero for a control that already clears the minimum, so it is safe to
 * apply unconditionally and stays correct if the height later grows.
 */
export function verticalHitSlop(renderedHeight: number): { top: number; bottom: number } {
  // A NaN height would otherwise poison the arithmetic into a NaN slop, which
  // React Native reads as no slop at all — the silent version of this bug.
  const height = Number.isFinite(renderedHeight) ? Math.max(0, renderedHeight) : 0;
  const shortfall = Math.max(0, MIN_HIT_TARGET_PT - height);
  const slop = Math.ceil(shortfall / 2);
  return { top: slop, bottom: slop };
}

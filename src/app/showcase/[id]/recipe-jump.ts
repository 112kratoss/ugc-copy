/**
 * The post page's links to its recipe (`href="#recipe"`: the rail's "Free
 * recipe · View", the phone's bar along the bottom edge, a paid recipe's
 * locked Remix) jump to a section that is often already on screen, a few
 * pixels under the link, and then the click moved nothing a person could see
 * (owner, 2026-11-12). The jump stays the browser's own; this rings the
 * section once after it, so the click always shows where it led.
 *
 * Drawn with the Web Animations API, so it needs no rule in either stylesheet,
 * and it is a fade of an outline's colour, nothing that moves, so it plays
 * under reduced motion too.
 */
export const RECIPE_SECTION_ID = 'recipe';
export const RECIPE_JUMP_ANIMATION_ID = 'recipe-jump';

const RING = (alpha: number) => ({
  outline: `2px solid rgba(52, 211, 153, ${alpha})`,
  outlineOffset: '10px',
  borderRadius: '24px',
});

export function showRecipeJump(doc: Document | undefined = typeof document === 'undefined' ? undefined : document) {
  const section = doc?.getElementById(RECIPE_SECTION_ID);
  // An engine without the API keeps the plain jump.
  if (!section || typeof section.animate !== 'function') return;

  // A second click starts the ring over rather than stacking two.
  section.getAnimations?.()
    .filter((animation) => animation.id === RECIPE_JUMP_ANIMATION_ID)
    .forEach((animation) => animation.cancel());
  section.animate(
    [RING(0), { ...RING(0.75), offset: 0.2 }, { ...RING(0.75), offset: 0.55 }, RING(0)],
    { id: RECIPE_JUMP_ANIMATION_ID, duration: 1400, easing: 'ease-out' },
  );
}

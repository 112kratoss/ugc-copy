import { afterEach, describe, expect, it, vi } from 'vitest';

import { RECIPE_JUMP_ANIMATION_ID, RECIPE_SECTION_ID, showRecipeJump } from '@/app/showcase/[id]/recipe-jump';

// The post page's links to its recipe jump to a section that is often already on
// screen, where the jump moves nothing (owner, 2026-11-12): the click rings it.
describe('showRecipeJump', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function recipeSection() {
    const section = document.createElement('section');
    section.id = RECIPE_SECTION_ID;
    document.body.append(section);
    return section;
  }

  it('rings the recipe section once, with an outline that fades in and out', () => {
    const section = recipeSection();
    const animate = vi.fn();
    section.animate = animate;

    showRecipeJump();

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0] as [Array<Record<string, unknown>>, KeyframeAnimationOptions];
    expect(options).toMatchObject({ id: RECIPE_JUMP_ANIMATION_ID });
    // It starts and ends on nothing, so the section is left as it was.
    expect(keyframes[0].outline).toContain(', 0)');
    expect(keyframes.at(-1)?.outline).toContain(', 0)');
    expect(keyframes.some((frame) => String(frame.outline).includes('0.75'))).toBe(true);
    // A colour fade only: nothing moves, so it plays under reduced motion too.
    expect(keyframes.every((frame) => !('transform' in frame))).toBe(true);
  });

  it('starts over on a second click instead of stacking two rings', () => {
    const section = recipeSection();
    const running = { id: RECIPE_JUMP_ANIMATION_ID, cancel: vi.fn() };
    const other = { id: 'something-else', cancel: vi.fn() };
    section.getAnimations = () => [running, other] as unknown as Animation[];
    section.animate = vi.fn();

    showRecipeJump();

    expect(running.cancel).toHaveBeenCalledTimes(1);
    expect(other.cancel).not.toHaveBeenCalled();
    expect(section.animate).toHaveBeenCalledTimes(1);
  });

  it('keeps the plain jump where there is no recipe section or no animation API', () => {
    expect(() => showRecipeJump()).not.toThrow();

    // jsdom has no Element.animate, as an old engine has none.
    recipeSection();
    expect(() => showRecipeJump()).not.toThrow();
  });
});

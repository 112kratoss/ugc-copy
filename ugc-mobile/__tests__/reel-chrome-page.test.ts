import { describe, expect, it, vi } from 'vitest';

import { createReelHandoffPage, reelChromePage } from '@/lib/reel-chrome-page';

// Audit 2026-11-27: after a swipe from a clip to a picture, the clip's sound
// control stood ~200 ms (S24) and at least 300 ms (iPhone) after the picture
// had landed, and a clip's came ~190 ms late (S24). The control followed the
// post the reel had settled on, which moves only once the list is at rest and
// the reel has drawn again; playback has moved on by then, at the moment the
// landing page took the screen over.
describe('reelChromePage', () => {
  it('is the page settled on while nothing has been handed on', () => {
    expect(reelChromePage(3, null)).toBe(3);
    expect(reelChromePage(3, { page: 3, settledIndex: 3 })).toBe(3);
  });

  it('is the page a swipe has handed playback to, before the list comes to rest', () => {
    expect(reelChromePage(3, { page: 4, settledIndex: 3 })).toBe(4);
    // Turned back past half way.
    expect(reelChromePage(3, { page: 3, settledIndex: 3 })).toBe(3);
    // The closing slide one page past the last post: no post's controls.
    expect(reelChromePage(9, { page: 10, settledIndex: 9 })).toBe(10);
  });

  it('is the page settled on once the reel has moved there, however it got there', () => {
    // The swipe's page, once the reel has settled on it.
    expect(reelChromePage(4, { page: 4, settledIndex: 3 })).toBe(4);
    // Moved on with no swipe (a post taken out of the reel): in the same
    // render, not one handed on from the page it was on before.
    expect(reelChromePage(2, { page: 3, settledIndex: 3 })).toBe(2);
    expect(reelChromePage(5, { page: 4, settledIndex: 3 })).toBe(5);
  });
});

describe('createReelHandoffPage', () => {
  it('keeps the page handed playback, and the page settled on when it was', () => {
    const handoff = createReelHandoffPage();
    expect(handoff.page()).toBeNull();
    expect(handoff.reading()).toBeNull();

    handoff.settle(3);
    expect(handoff.page()).toBe(3);
    expect(handoff.reading()).toEqual({ page: 3, settledIndex: 3 });

    handoff.handTo(4);
    expect(handoff.page()).toBe(4);
    expect(handoff.reading()).toEqual({ page: 4, settledIndex: 3 });

    handoff.settle(4);
    expect(handoff.reading()).toEqual({ page: 4, settledIndex: 4 });
  });

  it('tells its listeners of each change, and only of a change', () => {
    const handoff = createReelHandoffPage();
    const listener = vi.fn();
    const unsubscribe = handoff.subscribe(listener);

    handoff.settle(1);
    handoff.settle(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const settled = handoff.reading();

    handoff.handTo(2);
    handoff.handTo(2);
    expect(listener).toHaveBeenCalledTimes(2);
    // A new reading for each change, the same one otherwise (useSyncExternalStore).
    expect(handoff.reading()).not.toBe(settled);

    unsubscribe();
    handoff.handTo(1);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

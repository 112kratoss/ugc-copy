import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Black behind the navigator while a pop reveals a reel (lib/reel-backdrop.ts):
 * iOS 26 draws a screen a pop reveals with the display's rounded corners, and
 * the app's light ground showed in them around the dark reel. Never while the
 * reel grows or shrinks itself: UIKit scales a pushed page round it then, and
 * black drew a frame round that lit page.
 */

// The reel's navigator: whatever listens for its transitions can be fired from the test.
const listeners = new Map<string, Set<(event?: unknown) => void>>();
const navigation = {
  addListener: (type: string, listener: (event?: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
    return () => listeners.get(type)?.delete(listener);
  },
};
vi.mock('expo-router', () => ({ useNavigation: () => navigation }));
function fire(type: string, closing?: boolean) {
  listeners.get(type)?.forEach((listener) => listener({ data: { closing } }));
}

import { isReelBackdropShown, resetReelBackdrop, subscribeToReelBackdrop, useReelBackdrop } from '../lib/reel-backdrop';

function Reel() {
  useReelBackdrop();
  return null;
}

afterEach(() => {
  resetReelBackdrop();
  listeners.clear();
});

describe('the backdrop behind a reel', () => {
  it('stays down while the reel grows out of its tile, rests and closes again', () => {
    let reel!: renderer.ReactTestRenderer;
    renderer.act(() => { reel = renderer.create(<Reel />); });
    // The push grows the reel out of its tile, over a page UIKit shrinks behind it.
    fire('transitionStart', false);
    expect(isReelBackdropShown()).toBe(false);
    fire('transitionEnd', false);
    expect(isReelBackdropShown()).toBe(false);
    // An edge swipe closes it into its tile.
    fire('transitionStart', true);
    expect(isReelBackdropShown()).toBe(false);
    renderer.act(() => reel.unmount());
    expect(isReelBackdropShown()).toBe(false);
  });

  it('comes up as a pop starts to reveal the reel from under a page pushed over it, and goes as that pop ends', () => {
    renderer.act(() => { renderer.create(<Reel />); });
    fire('transitionStart', false);
    fire('transitionEnd', false);
    // A creator profile slides over the reel.
    fire('transitionStart', true);
    expect(isReelBackdropShown()).toBe(false);
    fire('transitionEnd', true);
    expect(isReelBackdropShown()).toBe(false);
    // Back on the profile, or its edge swipe, starts to reveal the reel.
    fire('transitionStart', false);
    expect(isReelBackdropShown()).toBe(true);
    fire('transitionEnd', false);
    expect(isReelBackdropShown()).toBe(false);
    // The reel up again, its own close is no reveal.
    fire('transitionStart', true);
    expect(isReelBackdropShown()).toBe(false);
  });

  it('goes when a reveal is let go of and the page stays over the reel', () => {
    renderer.act(() => { renderer.create(<Reel />); });
    fire('transitionEnd', true);
    fire('transitionStart', false);
    expect(isReelBackdropShown()).toBe(true);
    // Light pages popped back to one another above it keep the light ground behind their corners.
    fire('transitionEnd', true);
    expect(isReelBackdropShown()).toBe(false);
  });

  it('stays up while any reel holds it, tells whoever draws it, and goes with the last of them', () => {
    const listener = vi.fn();
    subscribeToReelBackdrop(listener);
    let first!: renderer.ReactTestRenderer;
    let second!: renderer.ReactTestRenderer;
    renderer.act(() => { first = renderer.create(<Reel />); });
    renderer.act(() => { second = renderer.create(<Reel />); });
    fire('transitionEnd', true);
    fire('transitionStart', false);
    expect(isReelBackdropShown()).toBe(true);
    renderer.act(() => second.unmount());
    expect(isReelBackdropShown()).toBe(true);
    renderer.act(() => first.unmount());
    expect(isReelBackdropShown()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

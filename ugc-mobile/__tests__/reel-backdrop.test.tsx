import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Black behind the navigator while a reel is on screen or being revealed
 * (lib/reel-backdrop.ts): iOS 26 draws a screen a pop reveals with the
 * display's rounded corners, and the app's light ground showed in them around
 * the dark reel.
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
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));
function fire(type: string, closing?: boolean) {
  listeners.get(type)?.forEach((listener) => listener({ data: { closing } }));
}

import { isReelBackdropShown, REEL_BACKDROP_CLOSE_MS, resetReelBackdrop, subscribeToReelBackdrop, useReelBackdrop } from '../lib/reel-backdrop';

function Reel() {
  useReelBackdrop();
  return null;
}

afterEach(() => {
  resetReelBackdrop();
  listeners.clear();
  vi.useRealTimers();
});

describe('the backdrop behind a reel', () => {
  it('is up while the reel is on screen, and gone with the reel', () => {
    let reel!: renderer.ReactTestRenderer;
    expect(isReelBackdropShown()).toBe(false);
    renderer.act(() => { reel = renderer.create(<Reel />); });
    expect(isReelBackdropShown()).toBe(true);
    renderer.act(() => reel.unmount());
    expect(isReelBackdropShown()).toBe(false);
  });

  it('goes once a page pushed over the reel has covered it, and comes back as a pop starts to reveal the reel', () => {
    renderer.act(() => { renderer.create(<Reel />); });
    // A creator profile slides over the reel.
    fire('transitionStart', true);
    expect(isReelBackdropShown()).toBe(true);
    fire('transitionEnd', true);
    // Light pages popped back to one another keep the light ground behind their corners.
    expect(isReelBackdropShown()).toBe(false);
    // Back on the profile, or its edge swipe, starts to reveal the reel.
    fire('transitionStart', false);
    expect(isReelBackdropShown()).toBe(true);
  });

  it('outlasts a reel Back removes until its close has landed', () => {
    vi.useFakeTimers();
    let reel!: renderer.ReactTestRenderer;
    renderer.act(() => { reel = renderer.create(<Reel />); });
    // Back: the reel leaves React before UIKit has shrunk it into its tile, and
    // UIKit scales a pushed page up from behind it meanwhile.
    fire('beforeRemove');
    renderer.act(() => reel.unmount());
    expect(isReelBackdropShown()).toBe(true);
    vi.advanceTimersByTime(REEL_BACKDROP_CLOSE_MS - 1);
    expect(isReelBackdropShown()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isReelBackdropShown()).toBe(false);
  });

  it('stays up while any reel on screen holds it, and tells whoever draws it', () => {
    const listener = vi.fn();
    subscribeToReelBackdrop(listener);
    let first!: renderer.ReactTestRenderer;
    let second!: renderer.ReactTestRenderer;
    renderer.act(() => { first = renderer.create(<Reel />); });
    renderer.act(() => { second = renderer.create(<Reel />); });
    renderer.act(() => second.unmount());
    expect(isReelBackdropShown()).toBe(true);
    renderer.act(() => first.unmount());
    expect(isReelBackdropShown()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

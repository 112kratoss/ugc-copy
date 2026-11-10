import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * A reel grows out of the page-shaped view beside its tile
 * (`appleZoomOpenSourceId`) and closes into the tile's own view, which UIKit
 * shrinks it into the shape of (lib/apple-zoom.ts). It points the zoom at the
 * tile's view once it has landed, and not before: when the navigator reports
 * the push's end, or once the reel has had the time to draw at full size,
 * whichever comes first.
 */

type Listener = (event: { data?: { closing?: boolean; action?: { type: string } } }) => void;
const listeners = new Map<string, Set<Listener>>();
const setParams = vi.fn();
let params: Record<string, string> = {};
const navigation = {
  addListener: (name: string, listener: Listener) => {
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);
    return () => set.delete(listener);
  },
  setParams: (next: Record<string, string>) => {
    setParams(next);
    params = { ...params, ...next };
  },
};
const emit = (name: string, closing: boolean) => listeners.get(name)?.forEach((listener) => listener({ data: { closing } }));
/** What React Navigation sends a screen about to be removed by `action`. */
const emitRemove = (type: string) => listeners.get('beforeRemove')?.forEach((listener) => listener({ data: { action: { type } } }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
}));
vi.mock('expo-router', () => ({
  Link: { AppleZoomTarget: ({ children }: { children?: React.ReactNode }) => children },
  useLocalSearchParams: () => params,
  useNavigation: () => navigation,
}));
vi.mock('expo-router/build/link/preview/native', () => ({ LinkZoomTransitionSource: () => null }));
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));

import { APPLE_ZOOM_LANDED_AFTER_MS, useAppleZoomRetarget } from '../components/apple-zoom.ios';
import { APPLE_ZOOM_SOURCE_PARAM, appleZoomOpenSourceId, appleZoomSourceId } from '../lib/apple-zoom';
import { isAppleZoomReturnPictureHeld, noteAppleZoomPopEnded, resetAppleZoomReturnPictures } from '../lib/apple-zoom-surface';

function Reel({ activeItemId, pictureReturns }: { activeItemId: string; pictureReturns?: boolean }) {
  useAppleZoomRetarget(activeItemId, pictureReturns);
  return null;
}

describe('a reel grown out of its tile\'s page-shaped view', () => {
  it('points the zoom at the tile\'s own view once the push has landed, not before', () => {
    const tile = appleZoomSourceId(':r1:', 'post-1');
    params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomOpenSourceId(tile) };
    setParams.mockClear();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Reel activeItemId="post-1" />);
    });
    // A close's transition, or the push still running: nothing moves.
    renderer.act(() => emit('transitionEnd', true));
    expect(setParams).not.toHaveBeenCalled();

    renderer.act(() => emit('transitionEnd', false));
    expect(setParams).toHaveBeenCalledWith({ [APPLE_ZOOM_SOURCE_PARAM]: tile });

    // Swiped on to the next post: the tile of that post.
    renderer.act(() => tree.update(<Reel activeItemId="post-2" />));
    expect(setParams).toHaveBeenLastCalledWith({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(':r1:', 'post-2') });
    renderer.act(() => tree.unmount());
  });

  it('points the zoom at the post the reader is on when they moved before the push landed', () => {
    params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomOpenSourceId(appleZoomSourceId(':r1:', 'post-1')) };
    setParams.mockClear();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Reel activeItemId="post-1" />);
    });
    // Swiped on while the push still runs: the running zoom's source stays put.
    renderer.act(() => tree.update(<Reel activeItemId="post-2" />));
    expect(setParams).not.toHaveBeenCalled();

    renderer.act(() => emit('transitionEnd', false));
    expect(setParams).toHaveBeenCalledTimes(1);
    expect(setParams).toHaveBeenCalledWith({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(':r1:', 'post-2') });
    renderer.act(() => tree.unmount());
  });

  // UIKit reports the push's end half a second after the reel is at full
  // size, and a Back in that half second closed into the view the reel grew
  // out of. The same timer stands in for a report sent before the reel listened.
  it('counts the reel as landed once it has had the time to draw at full size, ahead of the navigator\'s word', () => {
    vi.useFakeTimers();
    try {
      const tile = appleZoomSourceId(':r1:', 'post-1');
      params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomOpenSourceId(tile) };
      setParams.mockClear();
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(<Reel activeItemId="post-1" />);
      });
      // The zoom is still growing the reel: its source stays put.
      renderer.act(() => { vi.advanceTimersByTime(APPLE_ZOOM_LANDED_AFTER_MS - 1); });
      expect(setParams).not.toHaveBeenCalled();
      renderer.act(() => { vi.advanceTimersByTime(1); });
      expect(setParams).toHaveBeenCalledWith({ [APPLE_ZOOM_SOURCE_PARAM]: tile });
      // The navigator's word, when it comes, changes nothing more.
      renderer.act(() => emit('transitionEnd', false));
      expect(setParams).toHaveBeenCalledTimes(1);
      renderer.act(() => tree.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-points a reel opened from the tile\'s own view as the reader moves, as before', () => {
    params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(':r1:', 'post-1') };
    setParams.mockClear();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Reel activeItemId="post-1" />);
    });
    expect(setParams).not.toHaveBeenCalled();
    renderer.act(() => tree.update(<Reel activeItemId="post-2" />));
    expect(setParams).toHaveBeenCalledWith({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(':r1:', 'post-2') });
    renderer.act(() => tree.unmount());
  });
});

/**
 * A reel showing a post's still picture has the post's tile hold that picture
 * in the view a close shrinks the reel into, so the picture is there all the
 * way down into the tile instead of the page fading out short of it
 * (lib/apple-zoom-surface.ts).
 */
describe('the picture a reel\'s close lands on', () => {
  const held = (itemId: string) => isAppleZoomReturnPictureHeld(':r1:', itemId);

  function mountLanded(pictureReturns: boolean) {
    params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomOpenSourceId(appleZoomSourceId(':r1:', 'post-1')) };
    listeners.clear();
    resetAppleZoomReturnPictures();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Reel activeItemId="post-1" pictureReturns={pictureReturns} />);
    });
    return tree;
  }

  it('is held once the push has landed, by the tile of the post the reader is on', () => {
    const tree = mountLanded(true);
    // The push still runs: a close now shrinks into the view the push grew out of.
    expect(held('post-1')).toBe(false);

    renderer.act(() => emit('transitionEnd', false));
    expect(held('post-1')).toBe(true);

    renderer.act(() => tree.update(<Reel activeItemId="post-2" pictureReturns />));
    expect(held('post-1')).toBe(false);
    expect(held('post-2')).toBe(true);

    // On to a clip, or a later picture of the post: its tile holds nothing.
    renderer.act(() => tree.update(<Reel activeItemId="post-2" pictureReturns={false} />));
    expect(held('post-2')).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('is not asked for by a reel that is not showing its tile\'s picture', () => {
    const tree = mountLanded(false);
    renderer.act(() => emit('transitionEnd', false));
    expect(held('post-1')).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('is let go when the reel goes after UIKit\'s own pop, which is over by then', () => {
    const tree = mountLanded(true);
    renderer.act(() => emit('transitionEnd', false));
    // The bar's Back, a drag or the edge swipe: the reel hears the pop begin
    // and leaves React only once it has ended.
    renderer.act(() => emit('transitionStart', true));
    expect(held('post-1')).toBe(true);
    renderer.act(() => tree.unmount());
    expect(held('post-1')).toBe(false);
  });

  it('stays through a pop the app asks for, which begins after the reel has left React', () => {
    const tree = mountLanded(true);
    renderer.act(() => emit('transitionEnd', false));
    // `router.back()`.
    renderer.act(() => emitRemove('GO_BACK'));
    renderer.act(() => tree.unmount());
    // UIKit has yet to ask what to shrink the reel into.
    expect(held('post-1')).toBe(true);
    noteAppleZoomPopEnded();
    expect(held('post-1')).toBe(false);
  });

  it('stays through a pop the app asks for after a close the reader let go of', () => {
    const tree = mountLanded(true);
    renderer.act(() => emit('transitionEnd', false));
    // A drag begun and let go: the reel is back.
    renderer.act(() => emit('transitionStart', true));
    renderer.act(() => emit('gestureCancel', false));
    renderer.act(() => emitRemove('POP'));
    renderer.act(() => tree.unmount());
    expect(held('post-1')).toBe(true);
    noteAppleZoomPopEnded();
    expect(held('post-1')).toBe(false);
  });

  // A replace, a reset, or the reel's navigator going: no zoom carries the
  // reel into the tile, and the tile stood hidden until the 1.5 s deadline.
  it('is let go at once when the reel goes by anything but a pop', () => {
    const replaced = mountLanded(true);
    renderer.act(() => emit('transitionEnd', false));
    renderer.act(() => emitRemove('REPLACE'));
    renderer.act(() => replaced.unmount());
    expect(held('post-1')).toBe(false);

    const unmounted = mountLanded(true);
    renderer.act(() => emit('transitionEnd', false));
    renderer.act(() => unmounted.unmount());
    expect(held('post-1')).toBe(false);
  });

  it('survives React running the reel\'s effects twice, as it does in development', () => {
    params = { [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(':r1:', 'post-1') };
    listeners.clear();
    resetAppleZoomReturnPictures();
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<React.StrictMode><Reel activeItemId="post-1" pictureReturns /></React.StrictMode>);
    });
    expect(held('post-1')).toBe(true);
    // Moving on lets the old tile go at once: nothing is waiting on a pop.
    renderer.act(() => tree.update(<React.StrictMode><Reel activeItemId="post-2" pictureReturns /></React.StrictMode>));
    expect(held('post-1')).toBe(false);
    expect(held('post-2')).toBe(true);
    renderer.act(() => tree.unmount());
    noteAppleZoomPopEnded();
  });
});

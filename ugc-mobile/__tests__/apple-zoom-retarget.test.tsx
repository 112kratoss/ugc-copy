import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * A reel grows out of the page-shaped view beside its tile
 * (`appleZoomOpenSourceId`) and closes into the tile's own view, which UIKit
 * shrinks it into the shape of (lib/apple-zoom.ts). It points the zoom at the
 * tile's view once its push has landed, and not before: the source of a
 * running zoom must not move.
 */

type Listener = (event: { data?: { closing?: boolean } }) => void;
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

import { useAppleZoomRetarget } from '../components/apple-zoom.ios';
import { APPLE_ZOOM_SOURCE_PARAM, appleZoomOpenSourceId, appleZoomSourceId } from '../lib/apple-zoom';

function Reel({ activeItemId }: { activeItemId: string }) {
  useAppleZoomRetarget(activeItemId);
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

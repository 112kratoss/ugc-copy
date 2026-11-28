import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The screen under a post that is opening takes no touches.
 *
 * The picture flies for about half a second before its reel is pushed, and the
 * reel is not the touched screen until it is up. A swipe in that time, meant
 * for the post, scrolled the grid beneath and left it coasting under the reel,
 * and Back returned to other posts (the owner's S24, 2026-11-28; 2,100 px on
 * the Pixel 9a emulator). A view over the surface takes those touches instead,
 * switched on the UI thread from the tap's own handler: put up by a render, it
 * arrived after a quick swipe had begun.
 */

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StatusBar: { currentHeight: 0 },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
}));
vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('expo-image', props),
}));
vi.mock('expo-router', () => ({
  useNavigation: () => ({ addListener: () => () => {} }),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));
vi.mock('@/components/letterbox-bands', () => ({
  LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props),
}));
vi.mock('@/components/top-scrim', () => ({
  TopScrim: (props: MockProps) => React.createElement('top-scrim', props),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

import { MediaZoomSurface, useMediaZoomSurfaceId } from '@/components/media-zoom';
import {
  beginTileOpen,
  claimTileOpen,
  endTileOpen,
  TILE_OPEN_TOUCH_HOLD_MAX_MS,
} from '@/lib/media-zoom-transition';

/** What the shield lets through, as the UI thread reads it: 'none' passes touches on, 'auto' takes them. */
function shieldOf(view: renderer.ReactTestRenderer) {
  // The stand-in for Reanimated reads an animated prop once, at render: draw again to read it now.
  act(() => view.update(surface()));
  const [shield] = view.root.findAll((node) => node.props.testID === 'tile-open-touch-shield' && typeof node.type === 'string');
  return shield;
}

const takes = (view: renderer.ReactTestRenderer) => shieldOf(view).props.animatedProps.pointerEvents === 'auto';

/** The id of the surface drawn last, as a tile on it knows it. */
let surfaceId: string | null = null;

function Tile() {
  surfaceId = useMediaZoomSurfaceId();
  return React.createElement('grid');
}

const surface = () => <MediaZoomSurface><Tile /></MediaZoomSurface>;

function mountSurface() {
  let view!: renderer.ReactTestRenderer;
  act(() => {
    view = renderer.create(surface());
  });
  return view;
}

let opened: number | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  act(() => endTileOpen(opened));
  opened = null;
  vi.useRealTimers();
});

describe('the screen under an opening post', () => {
  it('has a view over it that is always there, lets touches through, and takes them from the tap', () => {
    const view = mountSurface();
    const shield = shieldOf(view);
    expect(shield.props.animatedProps.pointerEvents).toBe('none');
    expect(shield.props.collapsable).toBe(false);
    expect(shield.props.style).toEqual({ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 });
    // The view takes the touch itself, so nothing under it starts a scroll.
    expect(shield.props.onStartShouldSetResponder()).toBe(true);

    act(() => {
      opened = beginTileOpen(Date.now(), 600, surfaceId);
    });
    expect(takes(view)).toBe(true);
  });

  it('lets touches through again once the reel the open pushed can be touched', () => {
    const view = mountSurface();
    act(() => {
      opened = beginTileOpen(Date.now(), 600, surfaceId);
    });
    act(() => {
      claimTileOpen(Date.now());
    });
    act(() => {
      vi.advanceTimersByTime(900);
    });
    // Past the tap's own hold, and still the reel's: it has not said it is up.
    expect(takes(view)).toBe(true);

    act(() => endTileOpen(opened));
    expect(takes(view)).toBe(false);
  });

  it('lets go by the clock when no reel takes the open over, or the reel never says it is up', () => {
    const view = mountSurface();
    act(() => {
      opened = beginTileOpen(Date.now(), 600, surfaceId);
    });
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(takes(view)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(3);
    });
    expect(takes(view)).toBe(false);

    act(() => {
      vi.setSystemTime(Date.now() + 10_000);
      opened = beginTileOpen(Date.now(), 600, surfaceId);
    });
    act(() => {
      claimTileOpen(Date.now());
    });
    expect(takes(view)).toBe(true);
    act(() => {
      vi.advanceTimersByTime(TILE_OPEN_TOUCH_HOLD_MAX_MS + 2);
    });
    expect(takes(view)).toBe(false);
  });

  it('covers the tapped tile\u2019s own screen only: not another surface, nor the one the open brings up', () => {
    const tapped = mountSurface();
    const tappedId = surfaceId;
    const other = mountSurface();
    act(() => {
      opened = beginTileOpen(Date.now(), 600, tappedId);
    });
    expect(takes(tapped)).toBe(true);
    expect(takes(other)).toBe(false);
    // The profile's card feed is a surface too, and mounts while the open is under way.
    expect(takes(mountSurface())).toBe(false);
  });

  it('takes nothing for a tile on no surface', () => {
    const view = mountSurface();
    act(() => {
      opened = beginTileOpen(Date.now(), 600, null);
    });
    expect(takes(view)).toBe(false);
  });
});

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Back on a picture post, on Android: the picture flies home alone (the
 * layer's copy of it, `ZoomGeometry.pictureOnly`), and the reel goes from
 * under it.
 *
 * The device audit (S24, 2026-11-27) measured ~160–170 ms between Back and the
 * first movement. Part of it was the order: once the copy had drawn, the reel
 * was popped (`router.back()`), and the flight set off only in the frame after,
 * so it waited for the JS thread to render the route's removal — the reel's
 * unmount and the screen beneath taking the focus. That removal cost 100–133 ms
 * on an iPhone 16e (#718), where the bar's own Back now avoids it. A live close
 * (a video) already pops only once it has landed.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  // The layer's own flight is Android's; iOS hands the close to UIKit's zoom.
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

/** What happened, in order: the flight's frames switched on or off, and the reel's exit. */
const timeline = vi.hoisted(() => [] as string[]);

// Frames never arrive in a rendered tree; what the layer's frame callback is
// told is the flight taking off (`takeOffZoomFlight`) and landing.
vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
  return {
    ...actual,
    useFrameCallback: () => ({
      setActive: (active: boolean) => timeline.push(active ? 'flight frames on' : 'flight frames off'),
      isActive: false,
      callbackId: -1,
    }),
  };
});

import { MediaZoomFlightLayer, useMediaZoomStage } from '../components/media-zoom';
import {
  clearPendingZoomOrigin,
  getZoomFlight,
  landZoomFlight,
  registerZoomSource,
  resetMediaZoomTransitions,
  setPendingZoomOrigin,
} from '../lib/media-zoom-transition';

const SCREEN = { width: 402, height: 874 };
const TILE = { x: 16, y: 300, width: 180, height: 240 };
/** The picture the reel is showing, which a close flies home alone. */
const PICTURE = { url: 'https://example.test/post.display.webp', cacheKey: 'post:display', thumbhash: null };

/** Every host node answers measurement, as a mounted native view does. */
const createNodeMock = () => ({
  measure: (report: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) =>
    report(0, 0, SCREEN.width, SCREEN.height, 0, 0),
});

afterEach(() => {
  clearPendingZoomOrigin();
  resetMediaZoomTransitions();
  timeline.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a picture closing alone, on Android', () => {
  function openReel() {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
    registerZoomSource('profile', 'post-1', {
      radius: 12,
      aspectRatio: 3 / 4,
      preview: null,
      setHidden: () => {},
      measure: (report) => report(TILE),
    });
    // The open's flight is over (another id than any flight now), so the reel
    // has landed and is uncovered as soon as it has drawn.
    setPendingZoomOrigin({
      surfaceId: 'profile',
      itemId: 'post-1',
      rect: TILE,
      radius: 12,
      aspectRatio: 3 / 4,
      preview: null,
      flightId: -1,
      recordedAt: Date.now(),
    });
    const exit = vi.fn(() => { timeline.push('reel popped'); });
    let stage!: ReturnType<typeof useMediaZoomStage>;
    function Reel() {
      stage = useMediaZoomStage({
        screen: SCREEN,
        initialItemId: 'post-1',
        activeItemId: 'post-1',
        aspectRatio: 3 / 4,
        activePicture: PICTURE,
        reducedMotion: false,
        ready: true,
        expectsNeighbours: false,
        onExit: exit,
      });
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <>
          <MediaZoomFlightLayer />
          <Reel />
        </>,
        { createNodeMock }
      );
    });
    // Drawn, its rail laid out (or given up on), uncovered: the reel at rest.
    renderer.act(() => { vi.advanceTimersByTime(1000); });
    expect(stage.opened).toBe(true);
    return { tree, exit, dismiss: () => stage.dismiss() };
  }

  /** The layer's copy of the picture has drawn, as expo-image says. */
  function copyDrawn(tree: renderer.ReactTestRenderer) {
    const copy = tree.root.findAll((node) => node.type === ('expo-image' as never) && node.props.source?.uri === PICTURE.url);
    expect(copy).toHaveLength(1);
    renderer.act(() => { copy[0]!.props.onDisplay(); });
  }

  it('sets off from the frame after the copy has drawn, and pops the reel once it has landed', () => {
    const { tree, exit, dismiss } = openReel();

    renderer.act(() => dismiss());
    const close = getZoomFlight();
    expect(close?.direction).toBe('close');
    expect(close?.geometry.pictureOnly).toBe(true);
    expect(timeline).toEqual([]);

    copyDrawn(tree);
    renderer.act(() => { vi.advanceTimersByTime(16); });

    // Moving, with the reel still there, out of sight under it.
    expect(timeline).toEqual(['flight frames on']);
    expect(exit).not.toHaveBeenCalled();

    renderer.act(() => { vi.advanceTimersByTime(48); });
    expect(exit).not.toHaveBeenCalled();

    renderer.act(() => { landZoomFlight(close!.id); });
    expect(timeline).toEqual(['flight frames on', 'reel popped']);
    expect(exit).toHaveBeenCalledTimes(1);

    // The safety net that keeps a reel from sticking pops nothing twice.
    renderer.act(() => { vi.advanceTimersByTime(2000); });
    expect(exit).toHaveBeenCalledTimes(1);

    renderer.act(() => tree.unmount());
  });
});

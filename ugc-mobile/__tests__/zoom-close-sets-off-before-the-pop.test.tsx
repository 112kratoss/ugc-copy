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
 *
 * Popped at the landing itself, the same render held back the landed picture's
 * release, and the picture stood over its tile, and over the tab bar or the
 * status strip in front of it, for that long (review of #947): the reel goes
 * once the picture has let go.
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

/**
 * What happened, in order: the flight's frames switched on and off, the
 * layer's picture let go of the tile, and the reel's exit.
 */
const timeline = vi.hoisted(() => [] as string[]);
/** The layer's frame callback, which the tests step as the device's frames would. */
const frames = vi.hoisted(() => ({ step: null as null | ((frame: { timeSincePreviousFrame: number | null }) => void) }));

vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
  return {
    ...actual,
    useFrameCallback: (callback: (frame: { timeSincePreviousFrame: number | null }) => void) => {
      frames.step = callback;
      return {
        setActive: (active: boolean) => timeline.push(active ? 'flight frames on' : 'flight frames off'),
        isActive: false,
        callbackId: -1,
      };
    },
  };
});

import { MediaZoomFlightLayer, useMediaZoomStage } from '../components/media-zoom';
import {
  clearPendingZoomOrigin,
  getHeldZoomPicture,
  getZoomFlight,
  registerZoomSource,
  resetMediaZoomTransitions,
  setPendingZoomOrigin,
  subscribeToHeldZoomPicture,
  type ZoomPreview,
} from '../lib/media-zoom-transition';

const SCREEN = { width: 402, height: 874 };
const TILE = { x: 16, y: 300, width: 180, height: 240 };
/** The picture the reel is showing, which a close flies home alone. */
const PICTURE = { url: 'https://example.test/post.display.webp', cacheKey: 'post:display', thumbhash: null };
/** The tile's own picture, which a close begun before the reel was uncovered turns round with. */
const TILE_PICTURE = { url: 'https://example.test/post.tile.webp', cacheKey: 'post:tile', thumbhash: null };
/** The longest a close waits for its landing before the reel is popped anyway (`DISMISS_SAFETY_MS` + `RETURN_DRAWN_DEADLINE_MS`). */
const SAFETY_MS = 670;

/** Every host node answers measurement, as a mounted native view does. */
const createNodeMock = () => ({
  measure: (report: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) =>
    report(0, 0, SCREEN.width, SCREEN.height, 0, 0),
});

afterEach(() => {
  clearPendingZoomOrigin();
  resetMediaZoomTransitions();
  timeline.length = 0;
  frames.step = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type ReelOptions = {
  /** The reel's picture on screen; null for a clip. */
  picture?: ZoomPreview | null;
  /** The clip on screen, for a live close. */
  videoUrl?: string | null;
  /** The tile's own picture, handed over with the tap. */
  tilePicture?: ZoomPreview | null;
  /** Left still being uncovered, for a close begun before the hand-off. */
  uncovered?: boolean;
};

function openReel({ picture = PICTURE, videoUrl = null, tilePicture = null, uncovered = true }: ReelOptions = {}) {
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
    preview: tilePicture,
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
      activePicture: picture,
      activeVideoUrl: videoUrl,
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
  if (uncovered) {
    // Drawn, its rail laid out (or given up on), uncovered: the reel at rest.
    renderer.act(() => { vi.advanceTimersByTime(1000); });
    expect(stage.opened).toBe(true);
  } else {
    expect(stage.opened).toBe(false);
  }
  // The layer's picture letting go, as the timeline's other entries are told.
  let held = getHeldZoomPicture();
  subscribeToHeldZoomPicture(() => {
    if (held && !getHeldZoomPicture()) timeline.push('picture let go');
    held = getHeldZoomPicture();
  });
  return { tree, exit, dismiss: () => stage.dismiss() };
}

/** The layer's copy of `picture` has drawn, as expo-image says. */
function copyDrawn(tree: renderer.ReactTestRenderer, picture: ZoomPreview = PICTURE) {
  const copy = tree.root.findAll((node) => node.type === ('expo-image' as never) && node.props.source?.uri === picture.url);
  expect(copy).toHaveLength(1);
  renderer.act(() => { copy[0]!.props.onDisplay(); });
}

/** The device's frames, until the close lands. */
function flyHome() {
  for (let frame = 0; frame < 40 && getZoomFlight(); frame += 1) {
    renderer.act(() => { frames.step?.({ timeSincePreviousFrame: 16 }); });
  }
  expect(getZoomFlight()).toBeNull();
}

function advance(ms: number) {
  renderer.act(() => { vi.advanceTimersByTime(ms); });
}

describe('a picture closing alone, on Android', () => {
  it('sets off from the frame after the copy has drawn, with the reel there, out of sight under it', () => {
    const { tree, exit, dismiss } = openReel();

    renderer.act(() => dismiss());
    const close = getZoomFlight();
    expect(close?.direction).toBe('close');
    expect(close?.geometry.pictureOnly).toBe(true);
    // The reel is still the thing on screen until its picture's copy is up.
    expect(timeline).toEqual([]);

    copyDrawn(tree);
    expect(timeline).toEqual([]);
    advance(16);

    expect(timeline).toEqual(['flight frames on']);
    expect(exit).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  // Review of #947: popped at the landing, the route's removal held the JS
  // thread before the landed picture's release could run.
  it('pops the reel once the landed picture has let go of its tile, and not before', () => {
    const { tree, exit, dismiss } = openReel();
    renderer.act(() => dismiss());
    copyDrawn(tree);
    advance(16);

    flyHome();
    expect(exit).not.toHaveBeenCalled();
    expect(getHeldZoomPicture()).not.toBeNull();

    // The picture lets go two frames after the landing (`finishZoomFlight`),
    // and the reel goes in the frame after that.
    advance(32);
    expect(getHeldZoomPicture()).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    advance(16);

    expect(timeline).toEqual(['flight frames on', 'flight frames off', 'picture let go', 'reel popped']);
    // The net that keeps a reel from sticking pops nothing twice.
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  it('still pops the reel when the close never lands', () => {
    const { tree, exit, dismiss } = openReel();
    renderer.act(() => dismiss());
    copyDrawn(tree);
    advance(16);
    expect(timeline).toEqual(['flight frames on']);

    // No frames reach the flight: the safety net, from the press.
    advance(SAFETY_MS - 32);
    expect(exit).not.toHaveBeenCalled();
    advance(32);
    expect(exit).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });
});

describe('a close of the old order, on Android', () => {
  // The reel may still be mounting, which would hold the flight's frames.
  it('pops a reel closed before it was uncovered first, and sets off in the frame after', () => {
    const { tree, exit, dismiss } = openReel({ tilePicture: TILE_PICTURE, uncovered: false });

    renderer.act(() => dismiss());
    expect(getZoomFlight()?.geometry.pictureOnly).toBe(false);
    copyDrawn(tree, TILE_PICTURE);
    advance(16);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(['reel popped']);

    advance(16);
    expect(timeline).toEqual(['reel popped', 'flight frames on']);
    renderer.act(() => tree.unmount());
  });

  it('sets a clip\'s close off at once, its window shrinking, and pops the reel at its landing', () => {
    const { tree, exit, dismiss } = openReel({ picture: null, videoUrl: 'https://example.test/post.mp4' });

    renderer.act(() => dismiss());
    expect(getZoomFlight()?.still).toBe(false);
    expect(timeline).toEqual(['flight frames on']);

    flyHome();
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });
});

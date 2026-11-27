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
 * layer's picture let go of the tile, the close setting off, and the reel's exit.
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
import { lendVideoPlayer } from '../lib/video-player-loans';
import {
  beginZoomFlight,
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
/**
 * The net that pops a closing reel whatever happens (`DISMISS_SAFETY_MS` +
 * `RETURN_DRAWN_DEADLINE_MS`): from the press for a close that never takes
 * off, and from take-off for one that pops at its landing.
 */
const SAFETY_MS = 670;
/** The longest a picture closing alone waits for its copy to draw (`PICTURE_CLOSE_DRAW_DEADLINE_MS`). */
const DRAW_DEADLINE_MS = 300;
/**
 * A picture the layer has never drawn. The layer remembers the last picture it
 * drew (module state no reset clears), and a close of that one is shown at
 * once, so a close that has to wait for its copy needs a picture of its own.
 */
const unseenPicture = (name: string): ZoomPreview => ({ url: `https://example.test/${name}.display.webp`, cacheKey: `${name}:display`, thumbhash: null });

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
  /** The playing clip the tile lent the open, which the reel has not yet taken. */
  tileVideo?: { player: never; url: string } | null;
  /**
   * How many of the close's first measures of the tile find nothing, as a
   * screen beneath that has just come back into layout answers (it is asked
   * again each frame, `TILE_REMEASURE_FRAMES`).
   */
  tileMissedMeasures?: number;
};

function openReel({ picture = PICTURE, videoUrl = null, tilePicture = null, uncovered = true, tileMissedMeasures = 0, tileVideo = null }: ReelOptions = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
  let missesLeft = tileMissedMeasures;
  registerZoomSource('profile', 'post-1', {
    radius: 12,
    aspectRatio: 3 / 4,
    preview: null,
    setHidden: () => {},
    measure: (report) => {
      if (missesLeft > 0) {
        missesLeft -= 1;
        report(null);
        return;
      }
      report(TILE);
    },
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
    video: tileVideo,
    flightId: -1,
    recordedAt: Date.now(),
  });
  const exit = vi.fn(() => { timeline.push('reel popped'); });
  const closeStarts = vi.fn(() => { timeline.push('close set off'); });
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
      onCloseStart: closeStarts,
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
  return { tree, exit, closeStarts, dismiss: () => stage.dismiss(), stage: () => stage };
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
    const { tree, exit, closeStarts, dismiss } = openReel();

    renderer.act(() => dismiss());
    const close = getZoomFlight();
    expect(close?.direction).toBe('close');
    expect(close?.geometry.pictureOnly).toBe(true);
    // The reel is still the thing on screen until its picture's copy is up.
    expect(timeline).toEqual([]);
    expect(closeStarts).not.toHaveBeenCalled();

    copyDrawn(tree);
    expect(timeline).toEqual(['close set off']);
    advance(16);

    expect(timeline).toEqual(['close set off', 'flight frames on']);
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

    expect(timeline).toEqual(['close set off', 'flight frames on', 'flight frames off', 'picture let go', 'reel popped']);
    // The net that keeps a reel from sticking pops nothing twice.
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  it('still pops the reel when the close never lands, timed from take-off', () => {
    const { tree, exit, dismiss } = openReel();
    renderer.act(() => dismiss());
    copyDrawn(tree);
    advance(16);
    expect(timeline).toEqual(['close set off', 'flight frames on']);

    // No frames reach the flight: the safety net, from the take-off a frame
    // after the press.
    advance(SAFETY_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    advance(1);
    expect(exit).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  // Review of #947: timed from the press, the net reached a close whose copy
  // took its whole draw deadline, flew ~200 ms and waited ~3 frames for the
  // release (~600–650 ms at 60 Hz) before it had landed on a busy thread, and
  // popped the reel mid-flight or before the picture let go.
  it('leaves a close whose copy was slow to draw to land and let go before the reel goes', () => {
    const { tree, exit, dismiss } = openReel({ picture: unseenPicture('slow-to-draw') });
    renderer.act(() => dismiss());

    // The copy never says it has drawn: the flight goes on its deadline.
    advance(DRAW_DEADLINE_MS);
    expect(timeline).toEqual(['close set off']);
    advance(16);
    expect(timeline).toEqual(['close set off', 'flight frames on']);

    // A busy thread: no frame reaches the flight for 300 ms, then a frame
    // each 16 ms until it lands, well past the press's 670 ms.
    advance(300);
    for (let frame = 0; frame < 40 && getZoomFlight(); frame += 1) {
      advance(16);
      renderer.act(() => { frames.step?.({ timeSincePreviousFrame: 16 }); });
    }
    expect(getZoomFlight()).toBeNull();
    expect(exit).not.toHaveBeenCalled();

    advance(32);
    expect(getHeldZoomPicture()).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    advance(16);
    expect(timeline).toEqual(['close set off', 'flight frames on', 'flight frames off', 'picture let go', 'reel popped']);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  // The press's net still stands for a close that never takes off: here its
  // flight is replaced by another before its copy draws, so it is never
  // shown, never moves and never lands.
  it('still pops the reel when the close never takes off, timed from the press', () => {
    const { tree, exit, dismiss } = openReel({ picture: unseenPicture('never-drawn') });
    renderer.act(() => dismiss());
    const close = getZoomFlight();
    renderer.act(() => {
      beginZoomFlight({ direction: 'open', geometry: close!.geometry, preview: TILE_PICTURE, still: true });
    });

    advance(SAFETY_MS - 1);
    expect(timeline).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    advance(1);
    expect(exit).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });
});

// The owner, 2026-11-27: "fix the back mid-opening wait too". Back pressed
// while the reel was still being built under the landed picture popped the
// reel first and set the picture off only once the route's removal had been
// rendered: on the S24 the first movement came ~160 ms after Back, the landed
// picture and its post standing as if Back had not been heard. Such a close
// now sets off first and pops the reel at its landing, as a picture's close
// out of a reel at rest has since #947.
describe('a close begun before the reel was uncovered, on Android', () => {
  it('sets off from the frame after its picture is up, with the reel there, out of sight', () => {
    const { tree, exit, dismiss } = openReel({ tilePicture: TILE_PICTURE, uncovered: false });

    renderer.act(() => dismiss());
    // The tile's own picture turns round, its post with it.
    expect(getZoomFlight()?.geometry.pictureOnly).toBe(false);
    expect(getZoomFlight()?.preview).toEqual(TILE_PICTURE);
    copyDrawn(tree, TILE_PICTURE);
    expect(timeline).toEqual(['close set off']);
    advance(16);

    expect(timeline).toEqual(['close set off', 'flight frames on']);
    expect(exit).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  it('pops the reel once the picture has landed in its tile and let go', () => {
    const { tree, exit, dismiss } = openReel({ tilePicture: TILE_PICTURE, uncovered: false });
    renderer.act(() => dismiss());
    copyDrawn(tree, TILE_PICTURE);
    advance(16);

    flyHome();
    expect(exit).not.toHaveBeenCalled();
    advance(16);

    expect(timeline).toEqual(['close set off', 'flight frames on', 'flight frames off', 'picture let go', 'reel popped']);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  it('still pops the reel when that close never lands, timed from its take-off', () => {
    const { tree, exit, dismiss } = openReel({ tilePicture: unseenPicture('turned-round-never-lands'), uncovered: false });
    renderer.act(() => dismiss());
    copyDrawn(tree, unseenPicture('turned-round-never-lands'));
    advance(16);

    advance(SAFETY_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    advance(1);
    expect(exit).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  // The reel left standing under the flight is the one being built: its rail
  // and caption mount once it has drawn, its neighbours once those are laid
  // out, each holding the UI thread the flight's frames are made on.
  it('builds no more of the reel once its close has begun', () => {
    const { tree, dismiss, stage } = openReel({ tilePicture: TILE_PICTURE, uncovered: false });
    expect(stage().drawn).toBe(false);
    expect(stage().chromeDrawn).toBe(false);

    renderer.act(() => dismiss());
    copyDrawn(tree, TILE_PICTURE);
    // Its picture painting, its rail reporting itself laid out, and every
    // deadline that would have uncovered it anyway.
    renderer.act(() => stage().reportPainted());
    renderer.act(() => stage().reportChromeDrawn());
    advance(1000);

    expect(stage().drawn).toBe(false);
    expect(stage().chromeDrawn).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it("gives the tile back the clip it lent before the reel goes", () => {
    const player = { id: 'lent-before-hand-off' } as never;
    lendVideoPlayer(player, () => timeline.push('tile took its clip back'));
    const { tree, exit, dismiss } = openReel({
      tilePicture: TILE_PICTURE,
      tileVideo: { player, url: 'https://example.test/post.feed.mp4' },
      uncovered: false,
    });

    renderer.act(() => dismiss());
    // The layer's view of the clip has drawn.
    const view = tree.root.findAll((node) => node.type === ('video-view' as never) && node.props.player === player);
    expect(view).toHaveLength(1);
    renderer.act(() => { view[0]!.props.onFirstFrameRender(); });
    advance(16);
    expect(exit).not.toHaveBeenCalled();

    flyHome();
    advance(16);
    expect(timeline).toEqual(['close set off', 'flight frames on', 'flight frames off', 'picture let go', 'tile took its clip back', 'reel popped']);
    renderer.act(() => tree.unmount());
  });
});

describe('a clip\'s close, on Android', () => {
  it('sets a clip\'s close off at once, its window shrinking, and pops the reel at its landing', () => {
    const { tree, exit, closeStarts, dismiss } = openReel({ picture: null, videoUrl: 'https://example.test/post.mp4' });

    renderer.act(() => dismiss());
    expect(getZoomFlight()?.still).toBe(false);
    expect(closeStarts).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(['flight frames on', 'close set off']);

    flyHome();
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });

  // Review of #949: the clip's close above measures its tile at once, and
  // passes whether or not its net is timed from the take-off.
  it("times a clip's net from its take-off, after its tile has measured as nothing for a few frames", () => {
    const { tree, exit, dismiss } = openReel({ picture: null, videoUrl: 'https://example.test/post.mp4', tileMissedMeasures: 3 });

    renderer.act(() => dismiss());
    expect(getZoomFlight()).toBeNull();
    // Asked again a frame apart: the third frame's answer is the tile.
    advance(48);
    expect(getZoomFlight()?.still).toBe(false);
    expect(timeline).toEqual(['flight frames on', 'close set off']);

    // No frame reaches the flight. Not from the press…
    advance(SAFETY_MS - 48);
    expect(exit).not.toHaveBeenCalled();
    // …but from the take-off.
    advance(47);
    expect(exit).not.toHaveBeenCalled();
    advance(1);
    expect(exit).toHaveBeenCalledTimes(1);
    renderer.act(() => tree.unmount());
  });
});

// Review of #949: a reel removed some other way while its close was on its
// way (a stack reset, a deep link) must leave nothing behind. A net re-armed
// after the unmount had cleared it popped a dead screen 670 ms later, and
// showed every tile a reel opened since was holding hidden.
describe('a closing reel that goes some other way', () => {
  it('sets off no net once it has gone, even at the take-off it had already asked for', () => {
    const { tree, exit, closeStarts, dismiss } = openReel({ picture: unseenPicture('gone-before-take-off') });
    renderer.act(() => dismiss());
    copyDrawn(tree, unseenPicture('gone-before-take-off'));
    expect(closeStarts).toHaveBeenCalledTimes(1);

    // Gone before the frame its take-off was asked for.
    renderer.act(() => tree.unmount());
    advance(16);
    advance(SAFETY_MS * 3);

    expect(exit).not.toHaveBeenCalled();
    expect(closeStarts).toHaveBeenCalledTimes(1);
  });
});

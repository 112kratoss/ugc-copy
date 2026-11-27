import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Android's back key while a tapped tile's post is opening (the owner,
 * 2026-11-27: "fix the back mid-opening wait too").
 *
 * The reel is pushed only as the picture lands (`OPEN_PUSH_AT`, or after
 * `OPEN_PUSH_DEADLINE_MS`), and takes the key only once it has mounted. Until
 * then the focused screen was the one beneath, and Back went to it: on the
 * Pixel 9a emulator, Back 0.51 s after a tap on a creator page popped that
 * page, and the reel landed over Home; the next Back closed it with a plain
 * fade, its tile's screen gone.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

/** React Native's back key: listeners newest first, until one takes the press. */
const backKey = vi.hoisted(() => {
  const listeners: (() => boolean)[] = [];
  return {
    listeners,
    api: {
      addEventListener: (_type: string, handler: () => boolean) => {
        listeners.push(handler);
        return {
          remove: () => {
            const at = listeners.indexOf(handler);
            if (at >= 0) listeners.splice(at, 1);
          },
        };
      },
    },
  };
});

vi.mock('react-native', () => ({
  // The layer's own flight is Android's; iOS pushes the reel at the tap under UIKit's zoom.
  Platform: { OS: 'android' },
  BackHandler: backKey.api,
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

/** What happened, in order. */
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

import { MediaZoomFlightLayer, MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource, useMediaZoomStage } from '../components/media-zoom';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  canOpenFromTile,
  getHeldZoomPicture,
  getZoomFlight,
  resetMediaZoomTransitions,
  subscribeToZoomFlights,
  type ZoomPreview,
} from '../lib/media-zoom-transition';

const SCREEN = { width: 402, height: 874 };

/** Every host node answers measurement, as a mounted native view does. */
const createNodeMock = () => ({
  measure: (report: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) =>
    report(0, 0, 180, 240, 16, 300),
});

afterEach(() => {
  resetMediaZoomTransitions();
  timeline.length = 0;
  backKey.listeners.length = 0;
  frames.step = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Android's back key pressed: whether anything in the app took it. Untaken, the navigator goes back. */
function pressBack() {
  for (const listener of [...backKey.listeners].reverse()) {
    if (listener()) return true;
  }
  timeline.push('navigator went back');
  return false;
}

function advance(ms: number) {
  renderer.act(() => { vi.advanceTimersByTime(ms); });
}

/** One of the device's frames reaching the flight. */
function frame() {
  renderer.act(() => { frames.step?.({ timeSincePreviousFrame: 16 }); });
}

/** The device's frames, until the flight in the air lands. */
function flyToLanding() {
  for (let count = 0; count < 40 && getZoomFlight(); count += 1) frame();
  expect(getZoomFlight()).toBeNull();
}

/** A profile with one tile, the layer above it, and the push a tap makes. */
function profileWithTile(picture: ZoomPreview, post: ImmersivePreviewItem | null = null) {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
  const push = vi.fn(() => { timeline.push('reel pushed'); });
  let source!: ReturnType<typeof useMediaZoomSource>;
  function Tile() {
    source = useMediaZoomSource({ itemId: 'post-1', aspectRatio: 3 / 4, preview: picture, post });
    return (
      <MediaZoomSourceView source={source}>
        <></>
      </MediaZoomSourceView>
    );
  }
  /** The screen with its tile, and the layer above it unless it has gone. */
  const app = (layer = true) => (
    <>
      <MediaZoomSurface>
        <Tile />
      </MediaZoomSurface>
      {layer ? <MediaZoomFlightLayer /> : null}
    </>
  );
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(app(), { createNodeMock });
  });
  /** A finger on the tile and off it: the open flight, its picture drawn so it moves. */
  const tap = () => {
    renderer.act(() => source.prepare());
    renderer.act(() => source.capture(push));
    const copy = tree.root.findAll((node) => node.type === ('expo-image' as never) && node.props.source?.uri === picture.url);
    expect(copy.length).toBeGreaterThan(0);
    renderer.act(() => { copy[0]!.props.onDisplay(); });
    expect(getZoomFlight()?.direction).toBe('open');
  };
  return {
    tree,
    push,
    tap,
    tapAgain: () => renderer.act(() => source.capture(push)),
    source: () => source,
    /** Draws the screen again, with the layer or without it. */
    rerender: (layer = true) => renderer.act(() => tree.update(app(layer))),
  };
}

/** A playing clip the tile offers the open, which records being handed back. */
function offerClip(source: ReturnType<typeof useMediaZoomSource>, id: string) {
  const player = { id } as never;
  renderer.act(() => {
    source.offerVideo({
      player,
      url: `https://example.test/${id}.feed.mp4`,
      hasFrame: () => true,
      reattach: () => timeline.push('tile took its clip back'),
    });
  });
  return player;
}

type Style = Record<string, unknown>;
const flatten = (style: unknown): Style => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style as Style | null) ?? {}
);

/** How opaque the layer's window is, as last drawn. */
function windowOpacity(tree: renderer.ReactTestRenderer) {
  const windows = tree.root.findAll((node) => node.type === ('animated-view' as never) && node.props.needsOffscreenAlphaCompositing);
  expect(windows).toHaveLength(1);
  return flatten(windows[0]!.props.style).opacity;
}

/** The reel the push brings up, mounting as a screen does. */
function mountReel() {
  const exit = vi.fn(() => { timeline.push('reel popped'); });
  function Reel() {
    useMediaZoomStage({
      screen: SCREEN,
      initialItemId: 'post-1',
      activeItemId: 'post-1',
      aspectRatio: 3 / 4,
      reducedMotion: false,
      ready: true,
      expectsNeighbours: false,
      onExit: exit,
    });
    return null;
  }
  let reel!: renderer.ReactTestRenderer;
  renderer.act(() => { reel = renderer.create(<Reel />, { createNodeMock }); });
  return { reel, exit };
}

const picture = (name: string): ZoomPreview => ({ url: `https://example.test/${name}.webp`, cacheKey: name, thumbhash: null });

/** The layer's timings, as the source sets them. */
const mediaZoomCode = readFileSync(path.resolve(__dirname, '../components/media-zoom.tsx'), 'utf8');
const constant = (name: string) => Number(mediaZoomCode.match(new RegExp(`const ${name} = (\\d+);`))?.[1]);
const OPEN_PUSH_DEADLINE_MS = constant('OPEN_PUSH_DEADLINE_MS');
const VIDEO_TAKEOFF_DEADLINE_MS = constant('VIDEO_TAKEOFF_DEADLINE_MS');
const CLOSE_MS = constant('CLOSE_MS');
const PLAIN_FADE_MS = constant('PLAIN_FADE_MS');
/** The hold in which a reel may take a tap's open over (`ORIGIN_TTL_MS`). */
const OPEN_HOLD_MS = 2000;

describe('Back during the open flight, before the reel is pushed', () => {
  it('is taken by the layer and turns the picture round into its tile; no reel is pushed and the screen beneath stays', () => {
    const { tree, push, tap } = profileWithTile(picture('back-mid-flight'));
    tap();
    frame();
    frame();
    frame();

    expect(pressBack()).toBe(true);
    expect(getZoomFlight()?.direction).toBe('close');

    flyToLanding();
    // The push's deadline passes too.
    advance(1000);
    expect(push).not.toHaveBeenCalled();
    expect(timeline).not.toContain('navigator went back');
    expect(getHeldZoomPicture()).toBeNull();
    renderer.act(() => tree.unmount());
  });

  it('swallows a second Back while the picture goes home, and lets the tile open again once it has', () => {
    const { tree, push, tap, tapAgain } = profileWithTile(picture('back-twice'));
    tap();
    frame();

    expect(pressBack()).toBe(true);
    expect(pressBack()).toBe(true);
    flyToLanding();
    advance(100);
    expect(timeline).not.toContain('navigator went back');

    // Home: Back is the screen's again, and the tile opens its post.
    expect(pressBack()).toBe(false);
    tapAgain();
    expect(getZoomFlight()?.direction).toBe('open');
    expect(push).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  it('gives the tile back the clip it lent the open, as the picture lands in it', () => {
    const { tree, push, source } = profileWithTile(picture('back-with-a-clip'));
    const player = offerClip(source(), 'lent-to-the-open');
    renderer.act(() => source().prepare());
    renderer.act(() => source().capture(push));
    expect(getZoomFlight()?.video?.player).toBe(player);
    // The layer's view of the clip has drawn, and the open sets off.
    const view = tree.root.findAll((node) => node.type === ('video-view' as never) && node.props.player === player);
    expect(view.length).toBeGreaterThan(0);
    renderer.act(() => { view[0]!.props.onFirstFrameRender(); });
    frame();
    frame();

    expect(pressBack()).toBe(true);
    expect(getZoomFlight()?.direction).toBe('close');
    expect(getZoomFlight()?.video?.player).toBe(player);
    flyToLanding();
    advance(100);

    expect(timeline).toContain('tile took its clip back');
    expect(getHeldZoomPicture()).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(timeline).not.toContain('navigator went back');
    renderer.act(() => tree.unmount());
  });

  // Review of #954: a close carrying a clip keeps its window out of sight
  // until the layer's view of the clip has drawn, and only a close told to
  // show it again does; turned round with nothing to say so, it flew empty.
  it('shows a clip it turns round as it flies home, though its window had not yet said it had drawn', () => {
    const { tree, push, source, rerender } = profileWithTile(picture('back-with-an-undrawn-clip'));
    const player = offerClip(source(), 'lent-not-yet-drawn');
    renderer.act(() => source().prepare());
    renderer.act(() => source().capture(push));
    expect(getZoomFlight()?.video?.player).toBe(player);
    // No word from the layer's view of the clip: the open goes on its deadline.
    advance(VIDEO_TAKEOFF_DEADLINE_MS);
    frame();
    frame();

    expect(pressBack()).toBe(true);
    expect(getZoomFlight()?.direction).toBe('close');
    expect(getZoomFlight()?.video?.player).toBe(player);
    // The close goes on the same deadline, its window shown as it goes.
    advance(VIDEO_TAKEOFF_DEADLINE_MS);
    rerender();
    expect(windowOpacity(tree)).toBe(1);

    flyToLanding();
    advance(100);
    expect(timeline).toContain('tile took its clip back');
    expect(getHeldZoomPicture()).toBeNull();
    expect(push).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  // Review of #954: a close with no layer to step it lands inside
  // `startZoomFlight`, before a wait begun after it could hear of it.
  it('gives the key and the tiles back at once when the close lands with no layer to step it', () => {
    const { tree, push, tap, rerender } = profileWithTile(picture('back-no-layer'));
    tap();
    frame();
    // The layer goes (a reload in development): a flight begun now lands at once.
    rerender(false);

    expect(pressBack()).toBe(true);
    expect(getZoomFlight()).toBeNull();
    // Home already: Back is the screen's, and tiles open posts.
    expect(pressBack()).toBe(false);
    expect(canOpenFromTile(Date.now())).toBe(true);
    expect(push).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });
});

describe('Back after the push, before the reel can answer it', () => {
  it('is taken by the layer, and the reel closes as soon as it is up, setting off before it is popped', () => {
    // The post as the tile listed it, which its picture carries up.
    const post = { id: 'post-1' } as ImmersivePreviewItem;
    const { tree, push, tap } = profileWithTile(picture('back-after-push'), post);
    tap();
    flyToLanding();
    expect(push).toHaveBeenCalledTimes(1);

    expect(pressBack()).toBe(true);
    expect(timeline).not.toContain('navigator went back');

    const { reel, exit } = mountReel();
    expect(getZoomFlight()?.direction).toBe('close');
    // Its rail and caption go down with it, though the reel, just mounted,
    // holds no post of its own yet.
    expect(getZoomFlight()?.post).toBe(post);
    advance(16);
    expect(exit).not.toHaveBeenCalled();
    flyToLanding();
    advance(16);
    expect(exit).toHaveBeenCalledTimes(1);
    // The open landed and pushed; the close set off, landed, and only then
    // was the reel popped.
    expect(timeline.slice(timeline.indexOf('reel pushed'))).toEqual([
      'reel pushed', 'flight frames on', 'flight frames off', 'reel popped',
    ]);
    renderer.act(() => reel.unmount());
    renderer.act(() => tree.unmount());
  });

  // Review of #954: the push also goes on its deadline, with the picture
  // still on its way up when the frames are slow.
  it('turns the open round mid-air when the reel was pushed on the deadline, before the picture had landed', () => {
    const { tree, push, tap } = profileWithTile(picture('back-after-deadline-push'));
    const openLandings: number[] = [];
    const stopListening = subscribeToZoomFlights((event) => {
      if (event.type === 'landed' && event.flight.direction === 'open') openLandings.push(event.flight.id);
    });
    tap();
    frame();
    // The frames stall: the reel is pushed on the deadline, the picture still in the air.
    advance(OPEN_PUSH_DEADLINE_MS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(getZoomFlight()?.direction).toBe('open');

    expect(pressBack()).toBe(true);
    const { reel, exit } = mountReel();
    // The close takes the picture over where the open had got it to.
    expect(getZoomFlight()?.direction).toBe('close');
    advance(16);
    let closeFrames = 0;
    for (; closeFrames < 40 && getZoomFlight(); closeFrames += 1) frame();
    expect(getZoomFlight()).toBeNull();
    expect(closeFrames).toBeLessThan(Math.ceil(CLOSE_MS / 16));
    advance(16);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(openLandings).toEqual([]);
    expect(timeline).toEqual(['flight frames on', 'reel pushed', 'flight frames on', 'flight frames off', 'reel popped']);
    stopListening();
    renderer.act(() => reel.unmount());
    renderer.act(() => tree.unmount());
  });

  // Review of #954: the open, its Back with it, was dropped by a reel that
  // came up after the hold, which then opened over the Back the layer took.
  it('still closes a reel slow to come up, past the hold in which it would have grown out of the tile', () => {
    const { tree, push, tap } = profileWithTile(picture('back-slow-reel'));
    tap();
    flyToLanding();
    expect(push).toHaveBeenCalledTimes(1);
    expect(pressBack()).toBe(true);

    // A first open after a cold start: the reel comes up after the hold.
    advance(OPEN_HOLD_MS + 100);
    const { reel, exit } = mountReel();
    // The reel has taken the open over, and the key with it.
    expect(backKey.listeners).toHaveLength(0);
    // Too late to shrink into the tile, it goes plainly, without opening.
    advance(PLAIN_FADE_MS + 100);
    expect(exit).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(getHeldZoomPicture()).toBeNull();
    expect(timeline).not.toContain('navigator went back');
    renderer.act(() => reel.unmount());
    renderer.act(() => tree.unmount());
  });

  // A push that brings up no reel (refused, or some other screen) is never
  // taken over: the layer gives the key back once no reel could take it.
  it('is the navigator\'s again once no reel can take the open over', () => {
    const { tree, push, tap } = profileWithTile(picture('back-no-reel'));
    tap();
    flyToLanding();
    expect(push).toHaveBeenCalledTimes(1);

    advance(OPEN_HOLD_MS);
    expect(pressBack()).toBe(false);
    expect(timeline).toContain('navigator went back');
    renderer.act(() => tree.unmount());
  });

  it('is left to the reel once it is up and has taken the open over', () => {
    const { tree, tap } = profileWithTile(picture('back-to-the-reel'));
    tap();
    flyToLanding();
    const { reel, exit } = mountReel();

    // The reel's own Back (`useHardwareBack` in app/viewer.tsx) answers from
    // here; this test mounts none, so the press reaches the navigator.
    expect(pressBack()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    renderer.act(() => reel.unmount());
    renderer.act(() => tree.unmount());
  });
});

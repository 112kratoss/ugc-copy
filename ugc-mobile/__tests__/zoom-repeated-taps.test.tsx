import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Tapping a tile again while the post it opens is still on its way.
 *
 * Two things broke. The flight layer drew the finger's poster and the tap's
 * lent video in one view, so the hold turning from one into the other handed
 * that view another animated style — which React's development build reads
 * while diffing a re-rendered view's props for its performance track, and
 * Reanimated's style handle throws when it is read. Thrown from inside the
 * commit, it left React unable to render again ("Should not already be
 * working"): the app froze on whatever it last drew, on both simulators.
 *
 * And every tap that landed before the reel was on screen started the movement
 * over from the tile, flew the poster in place of the video the first tap had
 * lent, and — once the first reel had been pushed — pushed a second one on top
 * of it, so the reader had to come back twice.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
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

/** Every animated style an animated view was handed, in the order it was handed them. */
const stylesPerView: { handles: Set<object>; mountedWith: Set<object> }[] = [];

/**
 * Reanimated's own doubles, with one difference that matters here: an animated
 * style keeps its identity for the life of the hook, as the real one does — and
 * the animated view records which ones it is drawn with, so a view handed
 * another hook's style shows up as a change rather than as a crash three layers
 * down in React's development build.
 */
vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
  const stableStyle = (factory: () => unknown) => {
    const held = React.useRef<object | null>(null);
    if (!held.current) held.current = { __animatedStyle: factory };
    return held.current;
  };
  const collect = (style: unknown, into: Set<object>) => {
    if (Array.isArray(style)) {
      style.forEach((entry) => collect(entry, into));
      return;
    }
    if (style && typeof style === 'object' && '__animatedStyle' in style) into.add(style as object);
  };
  const AnimatedView = ({ children, style, ...props }: MockProps) => {
    const handles = new Set<object>();
    collect(style, handles);
    const record = React.useRef<{ handles: Set<object>; mountedWith: Set<object> } | null>(null);
    if (!record.current) {
      record.current = { handles: new Set(handles), mountedWith: new Set(handles) };
      stylesPerView.push(record.current);
    }
    handles.forEach((handle) => record.current!.handles.add(handle));
    return React.createElement('animated-view', { ...props, style }, children);
  };
  return {
    ...actual,
    useAnimatedStyle: stableStyle,
    useAnimatedProps: stableStyle,
    default: { ...actual.default, View: AnimatedView },
  };
});

import { MediaZoomFlightLayer, MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource, useMediaZoomStage } from '../components/media-zoom';
import {
  getZoomFlight,
  holdZoomPicture,
  landZoomFlight,
  resetMediaZoomTransitions,
  type ZoomGeometry,
} from '../lib/media-zoom-transition';

const SCREEN = { width: 402, height: 874 };
const PREVIEW = { url: 'https://example.test/post.webp', cacheKey: 'post', thumbhash: null };
const GEOMETRY: ZoomGeometry = { screen: SCREEN, tile: null, tileRadius: 0, aspectRatio: 9 / 16 };
/** Stands in for the tile's player, which only ever changes hands here. */
const PLAYER = { id: 'player' } as never;

/** Every host node answers measurement, as a mounted native view does. */
const createNodeMock = () => ({
  measure: (report: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) =>
    report(0, 0, 180, 240, 16, 300),
});

afterEach(() => {
  resetMediaZoomTransitions();
  stylesPerView.length = 0;
  vi.useRealTimers();
});

describe('the picture the flight carries', () => {
  it('draws a poster and a video in views of their own, so neither is ever restyled into the other', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<MediaZoomFlightLayer />, { createNodeMock });
    });

    // The finger's poster, drawn under the press.
    renderer.act(() => {
      holdZoomPicture({ preview: PREVIEW, geometry: GEOMETRY });
    });
    expect(tree.root.findAllByType('expo-image' as never).length).toBeGreaterThan(0);

    // The tap's lent video, which the poster's window turns into.
    renderer.act(() => {
      holdZoomPicture({ preview: PREVIEW, geometry: GEOMETRY, video: { player: PLAYER, url: 'https://example.test/post.mp4' } });
    });
    expect(tree.root.findAllByType('video-view' as never).length).toBe(1);

    // And back again, for a close that could not hand the player back.
    renderer.act(() => {
      holdZoomPicture({ preview: PREVIEW, geometry: GEOMETRY });
    });

    const restyled = stylesPerView.filter((view) => view.handles.size !== view.mountedWith.size);
    expect(restyled).toEqual([]);

    renderer.act(() => tree.unmount());
  });
});

describe('a tap while a post is already opening', () => {
  function Tile({ report }: { report: (source: ReturnType<typeof useMediaZoomSource>) => void }) {
    const source = useMediaZoomSource({ itemId: 'post-1', aspectRatio: 9 / 16, preview: PREVIEW });
    report(source);
    return (
      <MediaZoomSourceView source={source}>
        <></>
      </MediaZoomSourceView>
    );
  }

  function Reel({ onExit }: { onExit: () => void }) {
    useMediaZoomStage({
      screen: SCREEN,
      initialItemId: 'post-1',
      activeItemId: 'post-1',
      aspectRatio: 9 / 16,
      reducedMotion: false,
      ready: true,
      expectsNeighbours: false,
      onExit,
    });
    return null;
  }

  it('opens nothing until the reel it pushed is on screen', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    let source!: ReturnType<typeof useMediaZoomSource>;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <>
          <MediaZoomSurface>
            <Tile report={(value) => { source = value; }} />
          </MediaZoomSurface>
          <MediaZoomFlightLayer />
        </>,
        { createNodeMock }
      );
    });

    renderer.act(() => source.capture(open));
    const flight = getZoomFlight();
    expect(flight).not.toBeNull();

    // While the picture is still growing.
    renderer.act(() => source.capture(open));
    expect(getZoomFlight()?.id).toBe(flight?.id);

    // The reel is pushed once the window has grown, or its deadline has passed.
    renderer.act(() => { vi.advanceTimersByTime(600); });
    expect(open).toHaveBeenCalledTimes(1);

    // Landed, with the reel still being built: the tile is under the picture.
    renderer.act(() => { landZoomFlight(flight!.id); });
    renderer.act(() => source.capture(open));
    expect(open).toHaveBeenCalledTimes(1);
    expect(getZoomFlight()).toBeNull();

    // The reel itself, which holds the open until it can be touched.
    let reel!: renderer.ReactTestRenderer;
    renderer.act(() => {
      reel = renderer.create(<Reel onExit={() => {}} />, { createNodeMock });
    });
    renderer.act(() => source.capture(open));
    expect(open).toHaveBeenCalledTimes(1);

    // Gone: the tiles it covered open posts again.
    renderer.act(() => reel.unmount());
    renderer.act(() => source.capture(open));
    expect(open).toHaveBeenCalledTimes(1);
    expect(getZoomFlight()).not.toBeNull();

    renderer.act(() => tree.unmount());
  });

  it('opens a screen it cannot grow into once, and again once that screen is up', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    let source!: ReturnType<typeof useMediaZoomSource>;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      // No surface around it, so there is no tile to grow out of: the plain push
      // every profile Creation and text post takes.
      tree = renderer.create(<Tile report={(value) => { source = value; }} />, { createNodeMock });
    });

    renderer.act(() => source.capture(open));
    renderer.act(() => source.capture(open));
    expect(open).toHaveBeenCalledTimes(1);

    // The pushed screen has covered this one, and every touch it took before
    // that has been handled.
    renderer.act(() => { vi.advanceTimersByTime(400); });
    renderer.act(() => source.capture(open));
    expect(open).toHaveBeenCalledTimes(2);

    renderer.act(() => tree.unmount());
  });
});

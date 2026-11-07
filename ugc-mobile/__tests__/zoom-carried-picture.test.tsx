import { readFileSync } from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

/**
 * The tapped tile's picture, which the reel carries until its slide has painted
 * its own, is drawn by that slide over its own picture and under everything
 * drawn over that picture: the slide's rail and caption, and the reel's top
 * shade and Back. The stage used to draw it over the whole reel, and there it
 * hid them all for as long as the slide's picture took to paint — a larger
 * rendition than the tile's. On the Pixel 9a emulator (2026-11-03) a creation
 * opened from Profile still had Publish and Details missing, and Recreate half
 * covered, 2.5 s after the tap. Under iOS's own zoom the tile hands over its
 * picture as well, and the stage drew that over the reel's Back in the same way.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StatusBar: { currentHeight: 0 },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
}));
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('expo-image', props) }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }) }));
vi.mock('expo-video', () => ({ VideoView: (props: MockProps) => React.createElement('video-view', props) }));
vi.mock('@/components/letterbox-bands', () => ({
  LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props),
}));
vi.mock('@/components/top-scrim', () => ({ TopScrim: (props: MockProps) => React.createElement('top-scrim', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
  return {
    ...actual,
    // One shared value for the life of the hook, as the real one is: a deadline
    // the stage keys to one is armed at mount, not again at every render.
    useSharedValue: <T,>(initial: T) => React.useState(() => actual.makeMutable(initial))[0],
    // A fade ends the moment it starts, and says so, as it does once the UI thread has run it.
    withTiming: <T,>(toValue: T, _config?: unknown, done?: (finished: boolean) => void) => {
      done?.(true);
      return toValue;
    },
  };
});

import { MediaZoomCarriedPicture, MediaZoomStage, useMediaZoomStage } from '../components/media-zoom';
import { clearPendingZoomOrigin, resetMediaZoomTransitions, setPendingZoomOrigin, type ZoomPreview, type ZoomVideo } from '../lib/media-zoom-transition';

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const SCREEN = { width: 402, height: 874 };
const PREVIEW: ZoomPreview = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: 'tile-hash' };
const CARRIED_DEADLINE_MS = Number(read('components/media-zoom.tsx').match(/const CARRIED_DEADLINE_MS = (\d+);/)?.[1]);
const DRAWN_GRACE_MS = Number(read('components/media-zoom.tsx').match(/const DRAWN_GRACE_MS = (\d+);/)?.[1]);
const DRAWN_DEADLINE_MS = Number(read('components/media-zoom.tsx').match(/const DRAWN_DEADLINE_MS = (\d+);/)?.[1]);

/** What a tapped tile hands the reel: the Android flight's origin, or the one UIKit's zoom carries. */
function openFromTile({ native = false, video = null }: { native?: boolean; video?: ZoomVideo | null } = {}) {
  setPendingZoomOrigin({
    surfaceId: 'profile',
    itemId: 'post-1',
    rect: native ? null : { x: 16, y: 300, width: 180, height: 240 },
    radius: 12,
    aspectRatio: 9 / 16,
    preview: PREVIEW,
    video,
    // A flight that has already landed: none is in the air.
    flightId: native ? null : -1,
    native,
    recordedAt: Date.now(),
  });
}

/** A slide as the reel draws one: its picture, the tile's copy, then its rail. */
function Slide({ itemId }: { itemId: string }) {
  return React.createElement(
    'slide',
    { itemId },
    React.createElement('slide-picture'),
    React.createElement(MediaZoomCarriedPicture, { itemId }),
    React.createElement('slide-rail'),
  );
}

/** A slide with no picture for the copy to lie over: an audio, text or status page. */
function SlideWithoutPicture({ itemId }: { itemId: string }) {
  return React.createElement('slide', { itemId }, React.createElement('slide-audio'), React.createElement('slide-rail'));
}

let stage!: ReturnType<typeof useMediaZoomStage>;

type ReelProps = { reducedMotion?: boolean; openedOn?: 'picture' | 'no picture' };

/** The reel: the post it opened on and its neighbour, then its own Back over both. */
function Reel({ reducedMotion = false, openedOn = 'picture' }: ReelProps) {
  stage = useMediaZoomStage({
    screen: SCREEN,
    initialItemId: 'post-1',
    activeItemId: 'post-1',
    aspectRatio: 9 / 16,
    reducedMotion,
    ready: true,
    expectsNeighbours: false,
    onExit: () => {},
  });
  return (
    <MediaZoomStage stage={stage} screen={SCREEN}>
      {openedOn === 'picture' ? <Slide itemId="post-1" /> : <SlideWithoutPicture itemId="post-1" />}
      <Slide itemId="post-2" />
      {React.createElement('reel-back-control')}
    </MediaZoomStage>
  );
}

const mounted: renderer.ReactTestRenderer[] = [];
function mount(props: ReelProps = {}) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<Reel {...props} />);
  });
  mounted.push(tree);
  return tree;
}

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  clearPendingZoomOrigin();
  resetMediaZoomTransitions();
  vi.useRealTimers();
});

/** The host elements in the order they are drawn: each over everything before it. */
function drawingOrder(tree: renderer.ReactTestRenderer) {
  const order: string[] = [];
  const walk = (node: ReturnType<renderer.ReactTestRenderer['toJSON']> | string) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    order.push(node.type);
    node.children?.forEach(walk);
  };
  walk(tree.toJSON());
  return order;
}

/** Whether a rendered node is the host element of this name (the doubles above draw them). */
const isHost = (node: renderer.ReactTestInstance, type: string) => (node.type as unknown) === type;

const copiesIn = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => isHost(node, 'expo-image'));

function hostAbove(node: renderer.ReactTestInstance, type: string) {
  let parent = node.parent;
  while (parent && !isHost(parent, type)) parent = parent.parent;
  return parent;
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style ?? {}) as Record<string, unknown>;
}

function expectDrawnUnderTheChrome(tree: renderer.ReactTestRenderer) {
  const copies = copiesIn(tree);
  // Once, by the slide of the post the reel opened on, and by no neighbour.
  expect(copies).toHaveLength(1);
  expect(hostAbove(copies[0]!, 'slide')?.props.itemId).toBe('post-1');
  const order = drawingOrder(tree);
  const copy = order.indexOf('expo-image');
  expect(copy).toBeGreaterThan(order.indexOf('slide-picture'));
  expect(copy).toBeLessThan(order.indexOf('slide-rail'));
  // Nothing is drawn over the reel's own last layer: the stage adds no picture over it.
  expect(order.at(-1)).toBe('reel-back-control');
}

describe("the tile's picture a reel carries", () => {
  it('is drawn by the opened slide over its picture, under its rail and the reel\'s Back', () => {
    openFromTile();
    const tree = mount();
    expect(stage.zooming).toBe(true);
    expect(stage.carried).toMatchObject({ itemId: 'post-1', preview: PREVIEW });
    expectDrawnUnderTheChrome(tree);
  });

  it('lies where the stage drew it, fitted as the slide fits its picture, and comes up without a fade', () => {
    openFromTile();
    const [copy] = copiesIn(mount());
    expect(copy!.props.source).toEqual({ uri: PREVIEW.url, cacheKey: PREVIEW.cacheKey });
    expect(copy!.props.placeholder).toEqual({ thumbhash: PREVIEW.thumbhash });
    expect(copy!.props.contentFit).toBe('contain');
    expect(copy!.props.placeholderContentFit).toBe('contain');
    expect(copy!.props.transition).toBe(0);
    expect(flatten(copy!.props.style)).toMatchObject({ position: 'absolute', inset: 0 });
    const layer = hostAbove(copy!, 'animated-view')!;
    expect(layer.props.pointerEvents).toBe('none');
    expect(flatten(layer.props.style)).toMatchObject({ position: 'absolute', inset: 0, opacity: 1 });
  });

  it('says the reel\'s window is on screen once it has been drawn', () => {
    vi.useFakeTimers();
    openFromTile();
    const tree = mount();
    expect(stage.drawn).toBe(false);
    renderer.act(() => copiesIn(tree)[0]!.props.onDisplay());
    expect(stage.drawn).toBe(true);
  });

  it('gives way once the slide has painted its own picture', () => {
    openFromTile();
    const tree = mount();
    renderer.act(() => stage.reportPainted());
    expect(stage.carried).toBeNull();
    expect(copiesIn(tree)).toHaveLength(0);
    expect(stage.drawn).toBe(true);
  });

  it('is let go at the deadline when the slide never paints', () => {
    vi.useFakeTimers();
    expect(CARRIED_DEADLINE_MS).toBeGreaterThan(0);
    openFromTile();
    const tree = mount();
    renderer.act(() => { vi.advanceTimersByTime(CARRIED_DEADLINE_MS - 1); });
    expect(copiesIn(tree)).toHaveLength(1);
    renderer.act(() => { vi.advanceTimersByTime(1); });
    expect(stage.carried).toBeNull();
    expect(copiesIn(tree)).toHaveLength(0);
  });

  it('is drawn the same way under UIKit\'s zoom, whose tile hands over its picture too', () => {
    openFromTile({ native: true });
    const tree = mount();
    expect(stage.zooming).toBe(false);
    expect(stage.carried?.preview).toEqual(PREVIEW);
    expectDrawnUnderTheChrome(tree);
  });

  it('is not there for a video whose tile lent the reel its player', () => {
    openFromTile({ video: { player: { id: 'tile-player' } as unknown as VideoPlayer, url: 'https://example.test/clip.mp4' } });
    const tree = mount();
    expect(stage.carried).toBeNull();
    expect(copiesIn(tree)).toHaveLength(0);
  });

  it('is not there under Reduce Motion, where the reel simply appears', () => {
    openFromTile();
    const tree = mount({ reducedMotion: true });
    expect(stage.carried).toBeNull();
    expect(copiesIn(tree)).toHaveLength(0);
  });
});

/**
 * The reel screen does not render under vitest, so these hold its slides to
 * drawing the copy where the test above draws it.
 */
describe('the reel slide that draws it', () => {
  const viewer = read('app/viewer.tsx');
  const slide = viewer.slice(viewer.indexOf('const ImmersiveSlide = memo('), viewer.indexOf('function useDoubleTapSaveHeartAnimation('));
  const media = viewer.slice(viewer.indexOf('function ImmersiveMedia('), viewer.indexOf('type ActiveVideoProps'));

  it('is the page on screen of the slide the reader is on', () => {
    expect(media).toContain('const carriedPicture = onScreen ? <MediaZoomCarriedPicture itemId={postId} /> : null;');
    // A post of one page, and the page on screen of a post of several.
    expect(slide).toContain('onScreen={active}');
    expect(slide).toContain('onScreen={active && currentHorizontalIndex === pageIndex}');
    expect(viewer).toContain('onScreen={onScreen}');
  });

  it("lays it straight over a video's poster, under the video's own view and badges", () => {
    const video = media.slice(media.indexOf("if (mediaItem.mediaKind === 'video') {"), media.indexOf('if (mediaItem.url) {'));
    const poster = video.indexOf('onImageDisplay={reportSlidePainted}');
    const copy = video.indexOf('{carriedPicture}');
    expect(poster).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(poster);
    expect(video.indexOf('<ActiveVideo')).toBeGreaterThan(copy);
    expect(video.indexOf('<ViewerPlayBadge />')).toBeGreaterThan(copy);
  });

  it('lays it straight over a picture, inside the frame a double-tap saves from', () => {
    const image = media.slice(media.indexOf('if (mediaItem.url) {'), media.lastIndexOf('return ('));
    const copy = image.indexOf('{carriedPicture}');
    expect(copy).toBeGreaterThan(image.indexOf('onImageDisplay={reportSlidePainted}'));
    expect(copy).toBeLessThan(image.indexOf('</DoubleTapPressable>'));
  });

  it("draws the slide's rail and caption after its media, and the reel's shade and Back after the slides", () => {
    const onePage = slide.slice(slide.indexOf('if (pages.length <= 1) {'), slide.indexOf('</View>\n    );\n  }'));
    expect(onePage.indexOf('{renderChrome()}')).toBeGreaterThan(onePage.indexOf('<MediaSlidePage'));
    const pages = slide.slice(slide.indexOf('<Animated.FlatList\n        ref={horizontalRef}'));
    expect(pages.indexOf('{renderChrome()}')).toBeGreaterThan(pages.indexOf('<MediaSlidePage'));
    const reel = viewer.slice(viewer.indexOf('<MediaZoomStage stage={zoom}'), viewer.indexOf('</MediaZoomStage>'));
    const list = reel.indexOf('<FlatList');
    expect(reel.indexOf('<TopScrim topInset={topInset} over="media" />')).toBeGreaterThan(list);
    expect(reel.indexOf('<ViewerTopControl label="Go back" onPress={zoom.dismiss}')).toBeGreaterThan(list);
  });
});

// An audio, text or status page has no picture for the tile's copy to lie over,
// so no slide draws the copy and none says it has been drawn. Android's flight
// then waited for the reel's window to be drawn until its 500 ms deadline, and
// its chrome and hand-off landed about 380 ms later than a reel that carried
// nothing (the 120 ms grace).
describe("the window of a reel whose opened page draws no copy", () => {
  it('is drawn after the grace, as a reel that carried no picture is', () => {
    vi.useFakeTimers();
    expect(DRAWN_GRACE_MS).toBeGreaterThan(0);
    expect(DRAWN_DEADLINE_MS).toBeGreaterThan(DRAWN_GRACE_MS);
    openFromTile();
    const tree = mount({ openedOn: 'no picture' });
    expect(copiesIn(tree)).toHaveLength(0);
    expect(stage.drawn).toBe(false);
    renderer.act(() => { vi.advanceTimersByTime(DRAWN_GRACE_MS); });
    expect(stage.drawn).toBe(true);
  });

  it('waits for the copy instead where the opened page draws one', () => {
    vi.useFakeTimers();
    openFromTile();
    const tree = mount();
    renderer.act(() => { vi.advanceTimersByTime(DRAWN_GRACE_MS); });
    expect(stage.drawn).toBe(false);
    renderer.act(() => copiesIn(tree)[0]!.props.onDisplay());
    expect(stage.drawn).toBe(true);
  });
});

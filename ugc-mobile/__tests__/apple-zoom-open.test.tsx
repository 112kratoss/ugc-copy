import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer, VideoThumbnail } from 'expo-video';

/**
 * A tile opening the reel under iOS's own zoom transition (lib/apple-zoom.ts):
 * nothing is measured and nothing flies — the push carries the tile's
 * identifier, a playing video is lent along and held on the tile until the
 * push has landed, and the reel takes that player at once and hands it back
 * the moment a pop begins.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.4' },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
}));
// The tile's stand-in draws whatever it is given at once, as a cached picture
// does, and says so (`onDisplay`), unless a test holds it back.
const standInImage = vi.hoisted(() => ({ draws: true }));
vi.mock('expo-image', () => ({
  Image: (props: MockProps) => {
    const { source, onDisplay } = props as { source?: unknown; onDisplay?: () => void };
    React.useEffect(() => {
      if (source && standInImage.draws) onDisplay?.();
    });
    return React.createElement('expo-image', props);
  },
}));
vi.mock('expo-video', () => ({ VideoView: (props: MockProps) => React.createElement('video-view', props) }));
vi.mock('@/components/letterbox-bands', () => ({ LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props) }));
vi.mock('@/components/top-scrim', () => ({ TopScrim: (props: MockProps) => React.createElement('top-scrim', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('react-native-reanimated', async () => {
  const actual = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
  return {
    ...actual,
    // One shared value for the life of the hook, as the real one is: a tile
    // lifted at the tap is still lifted when it next renders.
    useSharedValue: <T,>(initial: T) => React.useState(() => actual.makeMutable(initial))[0],
  };
});

// The navigator, as the reel sees it: whatever listens for the push ending and
// the pop beginning can be fired from the test.
const listeners = new Map<string, Set<(event?: unknown) => void>>();
// One object for the reel's lifetime, as the navigator's own is.
let reelFocused = true;
const navigation = {
  addListener: (type: string, listener: (event?: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
    return () => listeners.get(type)?.delete(listener);
  },
  isFocused: () => reelFocused,
};
// A second reel, opened from a page pushed over the first, has a screen of its own.
const ReelNavigation = React.createContext<unknown>(null);
vi.mock('expo-router', () => ({ useNavigation: () => React.useContext(ReelNavigation) ?? navigation }));
function fire(type: string, event?: unknown) {
  listeners.get(type)?.forEach((listener) => listener(event));
}
function createNavigation() {
  const own = new Map<string, Set<(event?: unknown) => void>>();
  return {
    navigation: {
      addListener: (type: string, listener: (event?: unknown) => void) => {
        if (!own.has(type)) own.set(type, new Set());
        own.get(type)!.add(listener);
        return () => own.get(type)?.delete(listener);
      },
      isFocused: () => true,
    },
    fire: (type: string, event?: unknown) => own.get(type)?.forEach((listener) => listener(event)),
  };
}

// The zoom is available: iOS 18 on the bridgeless runtime.
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));

import {
  MediaZoomSourceView,
  MediaZoomSurface,
  peekOpeningPost,
  peekOpeningPreview,
  STAND_IN_POSTER_WAIT_MS,
  STAND_IN_STILL_KEEP_MS,
  STAND_IN_STILL_WAIT_MS,
  TILE_LIFT_DRAWN_DEADLINE_MS,
  useMediaZoomSource,
  useMediaZoomStage,
} from '../components/media-zoom';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { getHeldZoomPicture, getZoomFlight, peekPendingZoomOrigin, resetMediaZoomTransitions, subscribeToZoomFlights, type ZoomFlight } from '../lib/media-zoom-transition';
import { useMediaZoomVideoOffer } from '../lib/media-zoom-video-offer';
import {
  acceptVideoReturn,
  claimReturnedVideoPlayer,
  isVideoLoanHeld,
  isVideoPlayerHandedBack,
  isVideoPlayerOnLoan,
  isVideoReturnPending,
  RELEASED_LOAN_GRACE_MS,
  reportReturnedVideoDrawn,
  resetVideoPlayerLoans,
  VIDEO_RETURN_TIMEOUT_MS,
} from '../lib/video-player-loans';
import {
  createScreenVeil,
  followZoomVeilTransition,
  getZoomVeilOpacity,
  registerScreenVeil,
  resetZoomVeil,
  subscribeToZoomVeilOpacity,
  ZOOM_VEIL_LIFT_DELAY_MS,
  ZOOM_VEIL_LIFT_MS,
  ZoomVeilOwnerContext,
  type ScreenVeil,
  type ZoomVeilTransition,
} from '../lib/zoom-veil';

const PREVIEW = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: null };
const STREAM = 'https://example.test/clip.mp4';

function fakePlayer({ still = 'none' }: { still?: 'none' | 'never' | 'asked' } = {}) {
  const asked: Array<(stills: VideoThumbnail[]) => void> = [];
  const player = {
    pause: vi.fn(),
    release: vi.fn(),
    currentTime: 4.2,
    // The still of the frame a playing tile shows, for its stand-in: none to be
    // had, one that never comes, or each one when the test answers (`stills`).
    generateThumbnailsAsync: vi.fn(() => {
      if (still === 'never') return new Promise(() => {});
      if (still === 'asked') return new Promise<VideoThumbnail[]>((resolve) => asked.push(resolve));
      return Promise.reject(new Error('no still in a test'));
    }),
  } as unknown as VideoPlayer;
  return Object.assign(player, { stills: asked });
}

/** A still of the frame the player was showing at `time`. */
function fakeStill(name: string, time = 4.2) {
  return { name, requestedTime: time } as unknown as VideoThumbnail;
}

/** Answers the player's `index`th still read, a microtask later as the native read does. */
async function answerStill(player: ReturnType<typeof fakePlayer>, index: number, still: VideoThumbnail) {
  await renderer.act(async () => {
    player.stills[index]([still]);
  });
}

/**
 * Taps the tile and lets its open go through: the stand-in draws, a playing
 * tile's still settles a microtask later, and the push waits for the lift to
 * be drawn, which in a test tree only the lift's deadline reports.
 */
async function openTile(source: ReturnType<typeof useMediaZoomSource>, open: (zoom: unknown) => void = () => {}) {
  await renderer.act(async () => {
    source.capture(open);
  });
  await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
}

async function elapse(ms: number) {
  await renderer.act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

// The screen the tiles are on, and the black it is covered in (lib/zoom-veil.ts).
let feedVeil: ScreenVeil;
beforeEach(() => {
  vi.useFakeTimers();
  feedVeil = createScreenVeil();
  registerScreenVeil('feed', feedVeil);
});

afterEach(() => {
  resetMediaZoomTransitions();
  resetVideoPlayerLoans();
  resetZoomVeil();
  listeners.clear();
  reelFocused = true;
  standInImage.draws = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Tile({ report, player, post = null, itemId = 'post-1' }: { report: (source: ReturnType<typeof useMediaZoomSource>) => void; player?: VideoPlayer; post?: ImmersivePreviewItem | null; itemId?: string }) {
  const source = useMediaZoomSource({ itemId, aspectRatio: 9 / 16, preview: PREVIEW, post });
  report(source);
  return (
    <MediaZoomSourceView source={source}>
      {player ? <VideoLayer player={player} /> : <></>}
    </MediaZoomSourceView>
  );
}

/** A tile's video layer: offers its playing player to the zoom out of the tile. */
function VideoLayer({ player }: { player: VideoPlayer }) {
  const offer = useMediaZoomVideoOffer();
  React.useEffect(() => offer?.({ player, url: STREAM, hasFrame: () => true, reattach: () => {} }), [offer, player]);
  return null;
}

function mountTile(player?: VideoPlayer, screen: string | null = 'feed') {
  let source!: ReturnType<typeof useMediaZoomSource>;
  let tree!: renderer.ReactTestRenderer;
  const element = (itemId: string, tilePlayer = player) => (
    <ZoomVeilOwnerContext.Provider value={screen}>
      <MediaZoomSurface>
        <Tile report={(value) => { source = value; }} player={tilePlayer} itemId={itemId} />
      </MediaZoomSurface>
    </ZoomVeilOwnerContext.Provider>
  );
  renderer.act(() => {
    tree = renderer.create(element('post-1'));
  });
  return {
    get source() {
      return source;
    },
    tree,
    /** Renders the tile again, showing `itemId` (a recycled cell) or the same post. */
    rerender(itemId = 'post-1', tilePlayer = player) {
      renderer.act(() => tree.update(element(itemId, tilePlayer)));
    },
    /** The stand-in UIKit's zoom grows out of: what it draws, and whether it is lifted over the tile. */
    standIn() {
      const image = tree.root.findByType('expo-image' as never);
      const style = (image.props.style as unknown[]).flat() as Array<{ opacity?: number } | null>;
      return { source: image.props.source as unknown, lifted: style.some((part) => part?.opacity === 1) };
    },
  };
}

describe('a tile opening under the native zoom', () => {
  it('sends its identifier with the push and starts no flight', async () => {
    const tile = mountTile();
    const { source } = tile;
    expect(source.appleZoomId).toMatch(/^zoom\|.+\|post-1$/);

    const open = vi.fn();
    await openTile(source, open);

    expect(open).toHaveBeenCalledWith({ sourceId: source.appleZoomId });
    // Grown out of the tile's poster, lifted over the tile.
    tile.rerender();
    expect(tile.standIn()).toEqual({ source: { uri: PREVIEW.url, cacheKey: PREVIEW.cacheKey }, lifted: true });
    expect(getZoomFlight()).toBeNull();
    const origin = peekPendingZoomOrigin('post-1', Date.now());
    expect(origin).toMatchObject({ itemId: 'post-1', native: true, flightId: null, rect: null });
  });

  it('lends a playing video and keeps it on the tile until the push has landed', async () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;

    await openTile(source);

    expect(isVideoPlayerOnLoan(player)).toBe(true);
    expect(isVideoLoanHeld(tileKey, STREAM)).toBe(true);
    expect(peekPendingZoomOrigin('post-1', Date.now())?.video).toEqual({ player, url: STREAM });

    // The reel takes the player at once, and lets the tile go once the navigator says the push is over.
    const onExit = vi.fn();
    renderer.act(() => {
      renderer.create(<Reel onExit={onExit} />);
    });
    expect(isVideoLoanHeld(tileKey, STREAM)).toBe(true);
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    expect(isVideoLoanHeld(tileKey, STREAM)).toBe(false);
    expect(isVideoPlayerOnLoan(player)).toBe(true);
  });

  it('hands the player back to the tile the moment the pop begins', async () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    await openTile(source);

    const onExit = vi.fn();
    renderer.act(() => {
      renderer.create(<Reel onExit={onExit} playerFor={() => player} />);
    });
    // The tile would take the player back: it still shows this stream.
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    renderer.act(() => { fire('beforeRemove'); });

    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    // Standing still: Back pops a picture of the reel, one frame, and the tile
    // holds that frame while UIKit crossfades to it (lib/video-player-loans.ts).
    expect(player.pause).toHaveBeenCalledTimes(1);
    stopAccepting();
  });

  it('drops the feed\'s veil at the tap, covers the feed in black under the reel\'s transition, and lifts it as the pop begins', async () => {
    const { source } = mountTile();
    expect(feedVeil.cover.get()).toBe(0);
    await openTile(source);
    // Waiting for the reel's transition, and clear until it is bound: the
    // screen's veil switches to following only when React commits it, and a
    // cover raised at the tap showed black until then (lib/zoom-veil.ts).
    expect(getZoomVeilOpacity('feed')).toBe(0);
    expect(feedVeil.cover.get()).toBe(0);
    expect(peekPendingZoomOrigin('post-1', Date.now())?.veil).toMatchObject({ owner: 'feed' });

    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} report={(value) => { stage = value; }} />);
    });
    expect(stage.veil).toMatchObject({ owner: 'feed' });
    // The viewer's `AppleZoomProgress` hands the veil the reel's transition.
    const transition = { name: 'reel' } as unknown as ZoomVeilTransition;
    followZoomVeilTransition(stage.veil!, transition);
    expect(feedVeil.cover.get()).toBe(1);
    expect(getZoomVeilOpacity('feed')).toBe(transition);
    renderer.act(() => { fire('beforeRemove'); });
    // The test double resolves the delayed fade at once.
    expect(feedVeil.cover.get()).toBe(0);
  });

  // A reel whose first load outlives the zoom draws its loading or error shell,
  // which mounts no `AppleZoomProgress` and so binds no transition. Back from
  // there faded a cover still at 0 from the tap, over the lit feed.
  it('covers the feed for Back from a reel that never bound its transition, and fades it from there', async () => {
    const { source } = mountTile();
    await openTile(source);
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} />);
    });
    const set = vi.spyOn(feedVeil.cover, 'set');
    renderer.act(() => { fire('beforeRemove'); });
    // Up, then the fade, which the test double resolves at once.
    expect(set.mock.calls.map(([value]) => value)).toEqual([1, 0]);
    expect(getZoomVeilOpacity('feed')).toBeNull();
    set.mockRestore();
  });

  it('keeps the veil on the reel\'s own transition for the reel\'s whole life, so a gesture close can follow the finger', async () => {
    // Swapping the transition for a plain number detaches its Animated graph,
    // and React Native then drops the native nodes of the transition's values:
    // re-attached later they are fresh nodes react-native-screens no longer
    // drives, frozen at "open", and a dismissal gesture ran over solid black.
    const { source } = mountTile();
    await openTile(source);
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} report={(value) => { stage = value; }} />);
    });
    const transition = { name: 'reel' } as unknown as ZoomVeilTransition;
    followZoomVeilTransition(stage.veil!, transition);
    const seen: unknown[] = [];
    subscribeToZoomVeilOpacity('feed', () => seen.push(getZoomVeilOpacity('feed')));

    // Landed; a page pushed over the reel and popped off it; a dismissal
    // gesture let go of; then one carried through.
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    reelFocused = false;
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    reelFocused = true;
    renderer.act(() => { fire('transitionStart', { data: { closing: false } }); });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    renderer.act(() => { fire('gestureCancel'); });
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });

    expect(getZoomVeilOpacity('feed')).toBe(transition);
    expect(seen.every((value) => value === transition)).toBe(true);
    expect(feedVeil.cover.get()).toBe(1);
  });

  it('drops no veil for a tile on a screen without one', async () => {
    const { source } = mountTile(undefined, null);
    await openTile(source);
    expect(peekPendingZoomOrigin('post-1', Date.now())?.veil).toBeNull();
    expect(feedVeil.cover.get()).toBe(0);
  });

  it('closes a reel opened from a page above another reel without taking the first reel\'s veil down', async () => {
    const creatorVeil = createScreenVeil();
    registerScreenVeil('creator', creatorVeil);

    // Explore → a reel, landed.
    const { source: exploreTile } = mountTile();
    await openTile(exploreTile);
    let firstStage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} report={(value) => { firstStage = value; }} />);
    });
    followZoomVeilTransition(firstStage.veil!, { name: 'first reel' } as unknown as ZoomVeilTransition);
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    // A second later the reel can be touched, and tiles open posts again.
    vi.advanceTimersByTime(1000);
    // The creator page pushed over it is not the reel's to cover.
    reelFocused = false;
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(creatorVeil.cover.get()).toBe(0);

    // A tile on the creator page opens a second reel, and Back closes it.
    const { source: creatorTile } = mountTile(undefined, 'creator');
    await openTile(creatorTile);
    const second = createNavigation();
    let secondReel!: renderer.ReactTestRenderer;
    let secondStage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      secondReel = renderer.create(
        <ReelNavigation.Provider value={second.navigation}>
          <Reel onExit={() => {}} report={(value) => { secondStage = value; }} />
        </ReelNavigation.Provider>
      );
    });
    followZoomVeilTransition(secondStage.veil!, { name: 'second reel' } as unknown as ZoomVeilTransition);
    expect(creatorVeil.cover.get()).toBe(1);
    renderer.act(() => { second.fire('transitionEnd', { data: { closing: false } }); });
    renderer.act(() => { second.fire('beforeRemove'); });
    renderer.act(() => secondReel.unmount());
    vi.advanceTimersByTime(ZOOM_VEIL_LIFT_DELAY_MS + ZOOM_VEIL_LIFT_MS);
    expect(creatorVeil.cover.get()).toBe(0);

    // The page pops off the first reel, which then closes over black, not the lit feed.
    reelFocused = true;
    renderer.act(() => { fire('transitionStart', { data: { closing: false } }); });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    expect(feedVeil.cover.get()).toBe(1);
    renderer.act(() => { fire('beforeRemove'); });
    expect(feedVeil.cover.get()).toBe(0);
  });

  it('hands the player to the tile as a dismissal gesture begins, and takes it back when the gesture is let go of', async () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    await openTile(source);
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} playerFor={() => player} report={(value) => { stage = value; }} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    // The edge swipe, a drag or a pinch: the reel is still the focused route.
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    expect(isVideoPlayerHandedBack(player)).toBe(true);
    // Playing: a gesture keeps the reel itself, and both draw the clip going on.
    expect(player.pause).not.toHaveBeenCalled();
    expect(feedVeil.cover.get()).toBe(0);
    expect(stage.lentVideo?.reclaimed).toBe(0);
    // The tile takes it and draws the clip under the shrinking reel.
    expect(claimReturnedVideoPlayer(tileKey, STREAM)).toBe(player);

    renderer.act(() => { fire('gestureCancel'); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(false);
    expect(isVideoPlayerHandedBack(player)).toBe(false);
    expect(isVideoPlayerOnLoan(player)).toBe(true);
    expect(feedVeil.cover.get()).toBe(1);
    expect(stage.lentVideo?.reclaimed).toBe(1);

    // Let go of once more, then closed for good: handed back again, exactly once.
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    renderer.act(() => { fire('transitionStart', { data: { closing: false } }); });
    expect(stage.lentVideo?.reclaimed).toBe(2);
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    renderer.act(() => { fire('transitionEnd', { data: { closing: true } }); });
    renderer.act(() => { fire('beforeRemove'); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    expect(stage.lentVideo?.reclaimed).toBe(2);
    // The removal that ends a gesture close hands nothing over, and stops nothing.
    expect(player.pause).not.toHaveBeenCalled();
    stopAccepting();
  });

  it('keeps the player when a screen is pushed on top of it', async () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    await openTile(source);
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} playerFor={() => player} report={(value) => { stage = value; }} />);
    });
    const transition = { name: 'reel' } as unknown as ZoomVeilTransition;
    followZoomVeilTransition(stage.veil!, transition);
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    // A creator profile pushed from the reel: the same event, but the reel is no longer focused.
    reelFocused = false;
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(false);
    expect(isVideoPlayerOnLoan(player)).toBe(true);
    expect(feedVeil.cover.get()).toBe(1);
    expect(getZoomVeilOpacity('feed')).toBe(transition);
    stopAccepting();
  });

  // A playing tile stands in with a still of the frame it is showing, read as
  // the finger comes down (`prepare`) and drawn by the tap.
  it('opens a playing tile on the still of the frame it is showing', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    const open = vi.fn();
    renderer.act(() => tile.source.prepare());
    expect(player.generateThumbnailsAsync).toHaveBeenCalledWith([4.2], expect.anything());
    const still = fakeStill('touch');
    await answerStill(player, 0, still);

    await openTile(tile.source, open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(player.generateThumbnailsAsync).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn()).toEqual({ source: still, lifted: true });
  });

  // Review of #723: a still drawn for an earlier touch read as ready, so a tap
  // after a touch that turned into a scroll opened on an old frame.
  it('never opens on a still read for an earlier touch', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    const open = vi.fn();
    renderer.act(() => tile.source.prepare());
    await answerStill(player, 0, fakeStill('scrolled'));
    renderer.act(() => tile.source.prepare());

    await openTile(tile.source, open);
    expect(open).not.toHaveBeenCalled();

    const still = fakeStill('tapped');
    await answerStill(player, 1, still);
    await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn()).toEqual({ source: still, lifted: true });
  });

  // Review of #723: reads can come back out of order.
  it('counts only the latest read, whichever answers first', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    const open = vi.fn();
    renderer.act(() => tile.source.prepare());
    renderer.act(() => tile.source.prepare());
    await renderer.act(async () => {
      tile.source.capture(open);
    });

    await answerStill(player, 0, fakeStill('earlier touch'));
    await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
    expect(open).not.toHaveBeenCalled();
    expect(tile.standIn().source).toEqual({ uri: PREVIEW.url, cacheKey: PREVIEW.cacheKey });

    const still = fakeStill('latest touch');
    await answerStill(player, 1, still);
    await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn()).toEqual({ source: still, lifted: true });
  });

  it('reads the frame again for a press held while the clip played on', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    const open = vi.fn();
    renderer.act(() => tile.source.prepare());
    await answerStill(player, 0, fakeStill('at the touch', 4.2));
    (player as { currentTime: number }).currentTime = 4.8;

    await openTile(tile.source, open);
    expect(open).not.toHaveBeenCalled();
    expect(player.generateThumbnailsAsync).toHaveBeenLastCalledWith([4.8], expect.anything());

    const still = fakeStill('at the tap', 4.8);
    await answerStill(player, 1, still);
    await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn().source).toBe(still);
  });

  // Review of #723: at the wait's end the open went ahead without a lift, and
  // UIKit grew the reel out of a stand-in with nothing in it.
  it('grows a playing tile out of its poster when the still is late, and drops the still when it comes', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    const open = vi.fn();
    await renderer.act(async () => {
      tile.source.capture(open);
    });
    await elapse(STAND_IN_STILL_WAIT_MS);
    expect(open).not.toHaveBeenCalled();
    await elapse(TILE_LIFT_DRAWN_DEADLINE_MS);
    expect(open).toHaveBeenCalledTimes(1);
    expect(peekPendingZoomOrigin('post-1', Date.now())?.video).toEqual({ player, url: STREAM });

    await answerStill(player, 0, fakeStill('late'));
    tile.rerender();
    expect(tile.standIn()).toEqual({ source: { uri: PREVIEW.url, cacheKey: PREVIEW.cacheKey }, lifted: true });
  });

  it('grows a playing tile out of its poster when its player gives no still', async () => {
    const player = fakePlayer();
    const tile = mountTile(player);
    const open = vi.fn();
    await openTile(tile.source, open);
    expect(open).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn().lifted).toBe(true);
  });

  it('opens with the tile as it is when the stand-in draws nothing in time', async () => {
    standInImage.draws = false;
    const tile = mountTile();
    const open = vi.fn();
    await renderer.act(async () => {
      tile.source.capture(open);
    });
    expect(open).not.toHaveBeenCalled();
    await elapse(STAND_IN_POSTER_WAIT_MS);
    expect(open).toHaveBeenCalledTimes(1);
    tile.rerender();
    expect(tile.standIn().lifted).toBe(false);
  });

  // Review of #723: a recycled cell kept the still of the post it showed before.
  it('keeps no still in a cell recycled for another post', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    renderer.act(() => tile.source.prepare());
    await answerStill(player, 0, fakeStill('first post'));
    expect(tile.standIn().source).toEqual(fakeStill('first post'));

    tile.rerender('post-2', fakePlayer());
    expect(tile.source.standInStill).toBeNull();
    expect(tile.standIn().source).toBeNull();
  });

  // Review of #723: every touch while scrolling left a picture behind.
  it('drops a still no tap used', async () => {
    const player = fakePlayer({ still: 'asked' });
    const tile = mountTile(player);
    renderer.act(() => tile.source.prepare());
    await answerStill(player, 0, fakeStill('unused'));
    expect(tile.source.standInStill).not.toBeNull();

    await elapse(STAND_IN_STILL_KEEP_MS);
    expect(tile.source.standInStill).toBeNull();
    expect(tile.standIn().source).toEqual({ uri: PREVIEW.url, cacheKey: PREVIEW.cacheKey });
  });

  // Owner's iPhone, 2026-11-07: "closing the video is having some ghost like
  // feeling". A video whose tile takes its player back flies that player home
  // alone, as a picture does, rather than UIKit shrinking the whole page into
  // the tile's other frame.
  it('closes a video by flying its own player home alone, handing it to the tile still playing', async () => {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    // The tile, measured where it lies on the feed.
    (source.ref as { current: unknown }).current = {
      measure: (report: (x: number, y: number, w: number, h: number, pageX: number, pageY: number) => void) => report(0, 0, 185, 320, 12, 196),
      measureInWindow: () => {},
    };
    await openTile(source);
    const flights: ZoomFlight[] = [];
    const stop = subscribeToZoomFlights((event) => {
      if (event.type === 'begin') flights.push(event.flight);
    });
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} playerFor={() => player} activePicture={PREVIEW} report={(value) => { stage = value; }} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    renderer.act(() => stage.dismiss());

    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ direction: 'close', video: { player, url: STREAM }, landsOnPicture: false });
    expect(flights[0].geometry.pictureOnly).toBe(true);
    // Back to the tile at once, and playing: the flight and the tile draw the clip going on.
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    expect(player.pause).not.toHaveBeenCalled();
    // Landed (nothing steps the flight in a test, so it lands at once), the
    // copy stays over the tile until the tile's own view has drawn the player
    // it takes back, rather than uncover a tile still waiting for its picture.
    await elapse(40);
    expect(getHeldZoomPicture()?.video?.player).toBe(player);
    renderer.act(() => {
      claimReturnedVideoPlayer(tileKey, STREAM);
      reportReturnedVideoDrawn(player);
    });
    expect(getHeldZoomPicture()).toBeNull();
    stop();
    stopAccepting();
  });

  // Owner, 2026-11-07, of a tile showing its poster: "why this cat video is
  // closing so fast". UIKit's zoom shrank and faded the whole page into it in
  // about a tenth of a second. The clip flies home alone instead, and
  // dissolves into the poster the tile goes on showing.
  it('flies a video home alone into a tile that shows its poster, landing on that poster', async () => {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    (source.ref as { current: unknown }).current = {
      measure: (report: (x: number, y: number, w: number, h: number, pageX: number, pageY: number) => void) => report(0, 0, 185, 320, 12, 196),
      measureInWindow: () => {},
    };
    await openTile(source);
    const flights: ZoomFlight[] = [];
    const stop = subscribeToZoomFlights((event) => {
      if (event.type === 'begin') flights.push(event.flight);
    });
    // The page on screen is not the tile's picture: a later page of the post.
    const onScreen = { url: 'https://example.test/page-2.webp', cacheKey: 'page-2', thumbhash: null };
    let stage!: ReturnType<typeof useMediaZoomStage>;
    let reel!: renderer.ReactTestRenderer;
    renderer.act(() => {
      reel = renderer.create(<Reel onExit={() => {}} playerFor={() => player} activePicture={onScreen} report={(value) => { stage = value; }} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    // The tile does not take the player back: nothing registers for its stream.

    renderer.act(() => stage.dismiss());

    expect(flights).toHaveLength(1);
    // It lands on the tile's own picture, which the tile goes on showing (review
    // of #723: on the page on screen, it cut to the tile's cover as it let go).
    expect(flights[0]).toMatchObject({ direction: 'close', video: { player, url: STREAM }, landsOnPicture: true, preview: PREVIEW });
    expect(flights[0].geometry.pictureOnly).toBe(true);
    // Handed back all the same, so it outlives the reel until the flight has landed.
    expect(isVideoPlayerHandedBack(player)).toBe(true);
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);

    // Landed on the poster, with no tile to draw the player under it: the copy
    // goes two frames on, as a picture's does, not at the end of the wait for
    // a tile's view (review of #723: it stood over the tile's badges for that).
    expect(getHeldZoomPicture()?.landsOnPicture).toBe(true);
    await elapse(40);
    expect(getHeldZoomPicture()).toBeNull();

    // No tile took the player: it is released once the reel has gone and a
    // close could no longer be drawing it.
    renderer.act(() => reel.unmount());
    expect(player.release).not.toHaveBeenCalled();
    await elapse(VIDEO_RETURN_TIMEOUT_MS + RELEASED_LOAN_GRACE_MS);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(false);
    stop();
  });

  it('flies the poster home when the reel has no player for the post', async () => {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
    const { source } = mountTile();
    (source.ref as { current: unknown }).current = {
      measure: (report: (x: number, y: number, w: number, h: number, pageX: number, pageY: number) => void) => report(0, 0, 185, 320, 12, 196),
      measureInWindow: () => {},
    };
    await openTile(source);
    const flights: ZoomFlight[] = [];
    const stop = subscribeToZoomFlights((event) => {
      if (event.type === 'begin') flights.push(event.flight);
    });
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} playerFor={() => null} activePicture={PREVIEW} report={(value) => { stage = value; }} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });

    renderer.act(() => stage.dismiss());

    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ direction: 'close', video: null, preview: PREVIEW });
    expect(flights[0].geometry.pictureOnly).toBe(true);
    stop();
  });

  // Review of #723: the close flew the reel's player even when the hand-back
  // refused it, and that player went with the reel in the middle of the flight.
  it('keeps UIKit\'s zoom for a player the reel cannot hand back', async () => {
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 16));
    // A poster tile lends nothing; the reel plays a player of its own that no loan holds.
    const { source } = mountTile();
    const tileKey = source.tileKey!;
    (source.ref as { current: unknown }).current = {
      measure: (report: (x: number, y: number, w: number, h: number, pageX: number, pageY: number) => void) => report(0, 0, 185, 320, 12, 196),
      measureInWindow: () => {},
    };
    await openTile(source);
    const reelPlayer = fakePlayer();
    const flights: ZoomFlight[] = [];
    const stop = subscribeToZoomFlights((event) => {
      if (event.type === 'begin') flights.push(event.flight);
    });
    const onExit = vi.fn();
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={onExit} playerFor={() => reelPlayer} activePicture={PREVIEW} report={(value) => { stage = value; }} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    renderer.act(() => stage.dismiss());
    expect(flights).toHaveLength(0);
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(false);
    // Popped two frames on, once the tile is UIKit's to shrink into again.
    await elapse(40);
    expect(onExit).toHaveBeenCalledTimes(1);
    stop();
    stopAccepting();
  });

  it('dismisses by popping alone: UIKit shrinks the reel into the registered tile', async () => {
    const { source } = mountTile();
    await openTile(source);
    const onExit = vi.fn();
    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={onExit} report={(value) => { stage = value; }} />);
    });
    expect(stage.zooming).toBe(false);
    expect(stage.opened).toBe(true);

    renderer.act(() => stage.dismiss());

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(getZoomFlight()).toBeNull();
  });
});

function Reel({
  onExit,
  playerFor,
  report,
  activePicture,
}: {
  onExit: () => void;
  playerFor?: (itemId: string, url: string) => VideoPlayer | null;
  report?: (stage: ReturnType<typeof useMediaZoomStage>) => void;
  /** The picture on screen, which a close can fly home alone. */
  activePicture?: typeof PREVIEW;
}) {
  const stage = useMediaZoomStage({
    activePicture,
    screen: { width: 402, height: 874 },
    initialItemId: 'post-1',
    activeItemId: 'post-1',
    aspectRatio: 9 / 16,
    reducedMotion: false,
    ready: true,
    expectsNeighbours: false,
    activeVideoUrl: STREAM,
    playerFor,
    onExit,
  });
  report?.(stage);
  return null;
}

describe('what the tapped tile hands the reel for its first load', () => {
  const POST = { id: 'post-1', previewKind: 'video', creatorUsername: 'fluffy' } as unknown as ImmersivePreviewItem;

  it('records the post beside the picture at the tap, for two seconds, for that post only', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
    let source!: ReturnType<typeof useMediaZoomSource>;
    renderer.act(() => {
      renderer.create(
        <MediaZoomSurface>
          <Tile report={(value) => { source = value; }} post={POST} />
        </MediaZoomSurface>
      );
    });
    renderer.act(() => source.capture(() => {}));
    const now = Date.now();
    expect(peekOpeningPreview('post-1', now)).toEqual(PREVIEW);
    expect(peekOpeningPost('post-1', now)).toBe(POST);
    expect(peekOpeningPost('post-2', now)).toBeNull();
    expect(peekOpeningPost('post-1', now + 2001)).toBeNull();
  });

  it('hands over no post when the tile listed none', () => {
    let source!: ReturnType<typeof useMediaZoomSource>;
    renderer.act(() => {
      renderer.create(
        <MediaZoomSurface>
          <Tile report={(value) => { source = value; }} />
        </MediaZoomSurface>
      );
    });
    renderer.act(() => source.capture(() => {}));
    expect(peekOpeningPreview('post-1', Date.now())).toEqual(PREVIEW);
    expect(peekOpeningPost('post-1', Date.now())).toBeNull();
  });
});

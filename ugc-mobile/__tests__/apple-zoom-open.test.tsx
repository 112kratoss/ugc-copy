import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

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
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('expo-image', props) }));
vi.mock('expo-video', () => ({ VideoView: (props: MockProps) => React.createElement('video-view', props) }));
vi.mock('@/components/letterbox-bands', () => ({ LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props) }));
vi.mock('@/components/top-scrim', () => ({ TopScrim: (props: MockProps) => React.createElement('top-scrim', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));

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

import { MediaZoomSourceView, MediaZoomSurface, peekOpeningPost, peekOpeningPreview, useMediaZoomSource, useMediaZoomStage } from '../components/media-zoom';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { getZoomFlight, peekPendingZoomOrigin, resetMediaZoomTransitions } from '../lib/media-zoom-transition';
import { useMediaZoomVideoOffer } from '../lib/media-zoom-video-offer';
import {
  acceptVideoReturn,
  claimReturnedVideoPlayer,
  isVideoLoanHeld,
  isVideoPlayerHandedBack,
  isVideoPlayerOnLoan,
  isVideoReturnPending,
  resetVideoPlayerLoans,
} from '../lib/video-player-loans';
import {
  createScreenVeil,
  registerScreenVeil,
  resetZoomVeil,
  ZOOM_VEIL_LIFT_DELAY_MS,
  ZOOM_VEIL_LIFT_MS,
  ZoomVeilOwnerContext,
  type ScreenVeil,
} from '../lib/zoom-veil';

const PREVIEW = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: null };
const STREAM = 'https://example.test/clip.mp4';

function fakePlayer() {
  return { pause: vi.fn(), release: vi.fn() } as unknown as VideoPlayer;
}

// The screen the tiles are on, and the black it is covered in (lib/zoom-veil.ts).
let feedVeil: ScreenVeil;
beforeEach(() => {
  feedVeil = createScreenVeil();
  registerScreenVeil('feed', feedVeil);
});

afterEach(() => {
  resetMediaZoomTransitions();
  resetVideoPlayerLoans();
  resetZoomVeil();
  listeners.clear();
  reelFocused = true;
  vi.useRealTimers();
});

function Tile({ report, player, post = null }: { report: (source: ReturnType<typeof useMediaZoomSource>) => void; player?: VideoPlayer; post?: ImmersivePreviewItem | null }) {
  const source = useMediaZoomSource({ itemId: 'post-1', aspectRatio: 9 / 16, preview: PREVIEW, post });
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
  renderer.act(() => {
    tree = renderer.create(
      <ZoomVeilOwnerContext.Provider value={screen}>
        <MediaZoomSurface>
          <Tile report={(value) => { source = value; }} player={player} />
        </MediaZoomSurface>
      </ZoomVeilOwnerContext.Provider>
    );
  });
  return { source, tree };
}

describe('a tile opening under the native zoom', () => {
  it('sends its identifier with the push and starts no flight', () => {
    const { source } = mountTile();
    expect(source.appleZoomId).toMatch(/^zoom\|.+\|post-1$/);

    const open = vi.fn();
    renderer.act(() => source.capture(open));

    expect(open).toHaveBeenCalledWith({ sourceId: source.appleZoomId });
    expect(getZoomFlight()).toBeNull();
    const origin = peekPendingZoomOrigin('post-1', Date.now());
    expect(origin).toMatchObject({ itemId: 'post-1', native: true, flightId: null, rect: null });
  });

  it('lends a playing video and keeps it on the tile until the push has landed', () => {
    vi.useFakeTimers();
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;

    renderer.act(() => source.capture(() => {}));

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

  it('hands the player back to the tile the moment the pop begins', () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    renderer.act(() => source.capture(() => {}));

    const onExit = vi.fn();
    renderer.act(() => {
      renderer.create(<Reel onExit={onExit} playerFor={() => player} />);
    });
    // The tile would take the player back: it still shows this stream.
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    renderer.act(() => { fire('beforeRemove'); });

    expect(isVideoReturnPending(tileKey, STREAM)).toBe(true);
    stopAccepting();
  });

  it('covers the feed in black from the tap, and lifts it as the pop begins', () => {
    const { source } = mountTile();
    expect(feedVeil.cover.get()).toBe(0);
    renderer.act(() => source.capture(() => {}));
    expect(feedVeil.cover.get()).toBe(1);
    expect(peekPendingZoomOrigin('post-1', Date.now())?.veil).toMatchObject({ owner: 'feed' });

    let stage!: ReturnType<typeof useMediaZoomStage>;
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} report={(value) => { stage = value; }} />);
    });
    expect(stage.veil).toMatchObject({ owner: 'feed' });
    expect(feedVeil.cover.get()).toBe(1);
    renderer.act(() => { fire('beforeRemove'); });
    // The test double resolves the delayed fade at once.
    expect(feedVeil.cover.get()).toBe(0);
  });

  it('drops no veil for a tile on a screen without one', () => {
    const { source } = mountTile(undefined, null);
    renderer.act(() => source.capture(() => {}));
    expect(peekPendingZoomOrigin('post-1', Date.now())?.veil).toBeNull();
    expect(feedVeil.cover.get()).toBe(0);
  });

  it('closes a reel opened from a page above another reel without taking the first reel\'s veil down', () => {
    vi.useFakeTimers();
    const creatorVeil = createScreenVeil();
    registerScreenVeil('creator', creatorVeil);

    // Explore → a reel, landed.
    const { source: exploreTile } = mountTile();
    renderer.act(() => exploreTile.capture(() => {}));
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} />);
    });
    renderer.act(() => { fire('transitionEnd', { data: { closing: false } }); });
    // A second later the reel can be touched, and tiles open posts again.
    vi.advanceTimersByTime(1000);
    // The creator page pushed over it is not the reel's to cover.
    reelFocused = false;
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(creatorVeil.cover.get()).toBe(0);

    // A tile on the creator page opens a second reel, and Back closes it.
    const { source: creatorTile } = mountTile(undefined, 'creator');
    renderer.act(() => creatorTile.capture(() => {}));
    const second = createNavigation();
    let secondReel!: renderer.ReactTestRenderer;
    renderer.act(() => {
      secondReel = renderer.create(
        <ReelNavigation.Provider value={second.navigation}>
          <Reel onExit={() => {}} />
        </ReelNavigation.Provider>
      );
    });
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

  it('hands the player to the tile as a dismissal gesture begins, and takes it back when the gesture is let go of', () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    renderer.act(() => source.capture(() => {}));
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
    stopAccepting();
  });

  it('keeps the player when a screen is pushed on top of it', () => {
    const player = fakePlayer();
    const { source } = mountTile(player);
    const tileKey = source.tileKey!;
    renderer.act(() => source.capture(() => {}));
    renderer.act(() => {
      renderer.create(<Reel onExit={() => {}} playerFor={() => player} />);
    });
    const stopAccepting = acceptVideoReturn(tileKey, STREAM);

    // A creator profile pushed from the reel: the same event, but the reel is no longer focused.
    reelFocused = false;
    renderer.act(() => { fire('transitionStart', { data: { closing: true } }); });
    expect(isVideoReturnPending(tileKey, STREAM)).toBe(false);
    expect(isVideoPlayerOnLoan(player)).toBe(true);
    expect(feedVeil.cover.get()).toBe(1);
    stopAccepting();
  });

  it('dismisses by popping alone: UIKit shrinks the reel into the registered tile', () => {
    const { source } = mountTile();
    renderer.act(() => source.capture(() => {}));
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
}: {
  onExit: () => void;
  playerFor?: (itemId: string, url: string) => VideoPlayer | null;
  report?: (stage: ReturnType<typeof useMediaZoomStage>) => void;
}) {
  const stage = useMediaZoomStage({
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

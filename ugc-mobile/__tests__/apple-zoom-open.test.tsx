import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const navigation = {
  addListener: (type: string, listener: (event?: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
    return () => listeners.get(type)?.delete(listener);
  },
};
vi.mock('expo-router', () => ({ useNavigation: () => navigation }));
function fire(type: string, event?: unknown) {
  listeners.get(type)?.forEach((listener) => listener(event));
}

// The zoom is available: iOS 18 on the bridgeless runtime.
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => true }));

import { MediaZoomSourceView, MediaZoomSurface, useMediaZoomSource, useMediaZoomStage } from '../components/media-zoom';
import { getZoomFlight, peekPendingZoomOrigin, resetMediaZoomTransitions } from '../lib/media-zoom-transition';
import { useMediaZoomVideoOffer } from '../lib/media-zoom-video-offer';
import {
  acceptVideoReturn,
  isVideoLoanHeld,
  isVideoPlayerOnLoan,
  isVideoReturnPending,
  resetVideoPlayerLoans,
} from '../lib/video-player-loans';

const PREVIEW = { url: 'https://example.test/tile.webp', cacheKey: 'tile', thumbhash: null };
const STREAM = 'https://example.test/clip.mp4';

function fakePlayer() {
  return { pause: vi.fn(), release: vi.fn() } as unknown as VideoPlayer;
}

afterEach(() => {
  resetMediaZoomTransitions();
  resetVideoPlayerLoans();
  listeners.clear();
  vi.useRealTimers();
});

function Tile({ report, player }: { report: (source: ReturnType<typeof useMediaZoomSource>) => void; player?: VideoPlayer }) {
  const source = useMediaZoomSource({ itemId: 'post-1', aspectRatio: 9 / 16, preview: PREVIEW });
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

function mountTile(player?: VideoPlayer) {
  let source!: ReturnType<typeof useMediaZoomSource>;
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <MediaZoomSurface>
        <Tile report={(value) => { source = value; }} player={player} />
      </MediaZoomSurface>
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

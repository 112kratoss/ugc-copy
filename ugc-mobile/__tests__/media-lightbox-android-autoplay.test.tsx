import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

// The lightbox's clip did not start by itself on Android (Pixel 9a emulator,
// 2026-10-05): five seconds after the lightbox opened it sat at 00:00 with its
// controls up. The lightbox is a React Native Modal, on Android a dialog with a
// window of its own, and as it opens it takes the focus from the activity's
// window. React Native reports that as AppState `blur`. A preview pauses on
// `blur`, which is right for a clip on the page, now covered, and wrong for
// the clip inside the Modal that did the covering.
//
// This file renders the real lightbox, preview and hooks over a stand-in
// player, and sends the `blur` the Modal's opening sends on the device.

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;
type Listener = (event?: unknown) => void;
type StandInPlayer = {
  source: unknown; status: string; playing: boolean; wantsToPlay: boolean; currentTime: number;
  muted: boolean; volume: number; playbackRate: number; loop: boolean;
  play: Mock<() => void>; pause: Mock<() => void>; replaceAsync: Mock<(next: unknown) => Promise<void>>;
  addListener: (name: string, listener: Listener) => { remove: () => void };
};

const state = vi.hoisted(() => ({
  appListeners: new Map<string, Set<(event?: unknown) => void>>(),
  frames: [] as Array<() => void>,
  players: [] as unknown[],
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@/lib/use-media-source', () => ({ useMediaSource: (url: string) => ({ source: { uri: url }, requestKey: '' }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }) }));
vi.mock('@/components/media-preview', () => ({ StableMediaImage: (props: MockProps) => React.createElement('stable-image', props) }));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('retry-button', props),
}));
vi.mock('lucide-react-native', () => ({
  ArrowLeft: () => null, Share: () => null, Share2: () => null, ChevronLeft: () => null, ChevronRight: () => null, X: () => null,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: (name: string, listener: (event?: unknown) => void) => {
      if (!state.appListeners.has(name)) state.appListeners.set(name, new Set());
      state.appListeners.get(name)!.add(listener);
      return { remove: () => { state.appListeners.get(name)?.delete(listener); } };
    },
  },
  Dimensions: { get: () => ({ width: 400, height: 800 }), addEventListener: () => ({ remove: vi.fn() }) },
  StyleSheet: { flatten: (style: unknown) => Object.assign({}, ...[style].flat()) },
  // Its children are drawn in another window on Android; here only that they are drawn while it is visible.
  Modal: ({ children, visible, ...props }: MockProps) => React.createElement('modal', { visible, ...props }, visible ? children : null),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', { ...props, style: typeof style === 'function' ? undefined : style }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  ActivityIndicator: (props: MockProps) => React.createElement('loading', props),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
  // As Android's player answers: a request to play is kept while the player has
  // no clip and acted on when the clip arrives, and a pause takes it back.
  useVideoPlayer: (source: unknown, setup: (player: unknown) => void) => {
    const player = React.useMemo(() => {
      const listeners = new Map<string, Set<(event?: unknown) => void>>();
      const emit = (name: string, event: unknown) => { [...(listeners.get(name) ?? [])].forEach(each => each(event)); };
      const settle = () => {
        const playing = instance.wantsToPlay && instance.status === 'readyToPlay';
        if (playing === instance.playing) return;
        instance.playing = playing;
        emit('playingChange', { isPlaying: playing });
      };
      const instance = {
        source, status: source ? 'readyToPlay' : 'idle', playing: false, wantsToPlay: false, currentTime: 0,
        muted: false, volume: 1, playbackRate: 1, loop: false,
        play: vi.fn(() => { instance.wantsToPlay = true; settle(); }),
        pause: vi.fn(() => { instance.wantsToPlay = false; settle(); }),
        replaceAsync: vi.fn(async (next: unknown) => {
          instance.source = next;
          instance.status = next ? 'readyToPlay' : 'idle';
          emit('statusChange', { status: instance.status });
          settle();
        }),
        addListener: (name: string, listener: (event?: unknown) => void) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(listener);
          return { remove: () => { listeners.get(name)?.delete(listener); } };
        },
      };
      state.players.push(instance);
      setup(instance);
      return instance;
    }, [JSON.stringify(source)]);
    return player;
  },
}));

import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';

const CLIP: LightboxMediaItem = { id: 'camera', url: 'https://cdn.example.com/camera.mp4', mediaKind: 'video', label: 'Camera movement' };
const PICTURE: LightboxMediaItem = { id: 'board', url: 'https://cdn.example.com/board.jpg', mediaKind: 'image', label: 'Colour board' };
const PAGE_CLIP = 'https://cdn.example.com/post.mp4';

let tree: renderer.ReactTestRenderer | undefined;
beforeEach(() => {
  state.appListeners.clear(); state.frames = []; state.players = [];
  vi.stubGlobal('requestAnimationFrame', (frame: () => void) => state.frames.push(frame));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const players = () => state.players as StandInPlayer[];
const playerOf = (url: string) => players().find(player => (player.source as { uri?: string } | null)?.uri === url);

/** A page with one clip on it, and the lightbox the page opens, as a post's reference media has it. */
function Page({ lightbox }: { lightbox: LightboxMediaItem | null }) {
  return (
    <>
      <RecoverableVideoPreview url={PAGE_CLIP} style={{ height: 300 }} />
      <MediaLightbox items={lightbox ? [lightbox] : []} activeIndex={lightbox ? 0 : null} onClose={vi.fn()} onNavigate={vi.fn()} />
    </>
  );
}

/** Lays every preview out and lets its view make its surface: Android gives a player its clip only then. */
async function drawPreviews() {
  await renderer.act(async () => {
    tree!.root.findAll(node => String(node.type) === 'view' && typeof node.props.onLayout === 'function').forEach(view => view.props.onLayout());
    for (let pass = 0; pass < 3; pass += 1) state.frames.splice(0).forEach(frame => frame());
  });
}

/** What the device sends as a Modal's window takes the focus from the activity's. */
function blurTheActivityWindow() {
  renderer.act(() => { [...(state.appListeners.get('blur') ?? [])].forEach(listener => listener()); });
}

it('starts the lightbox clip by itself, though its own Modal takes the window focus as it opens', async () => {
  renderer.act(() => { tree = renderer.create(<Page lightbox={null} />); });
  await drawPreviews();
  renderer.act(() => tree!.update(<Page lightbox={CLIP} />));
  blurTheActivityWindow();
  await drawPreviews();

  const lightboxPlayer = playerOf(CLIP.url)!;
  expect(lightboxPlayer.source).toEqual({ uri: CLIP.url, useCaching: true });
  expect(lightboxPlayer.pause).not.toHaveBeenCalled();
  expect(lightboxPlayer.playing).toBe(true);
});

it('pauses a clip playing on the page when the lightbox opens over it, and plays the lightbox clip', async () => {
  renderer.act(() => { tree = renderer.create(<Page lightbox={null} />); });
  await drawPreviews();
  const pagePlayer = playerOf(PAGE_CLIP)!;
  // A press on the player's own play button.
  renderer.act(() => { pagePlayer.play(); });
  expect(pagePlayer.playing).toBe(true);

  renderer.act(() => tree!.update(<Page lightbox={CLIP} />));
  blurTheActivityWindow();
  await drawPreviews();

  expect(pagePlayer.playing).toBe(false);
  expect(playerOf(CLIP.url)!.playing).toBe(true);
});

it('pauses a clip playing on the page when a lightbox with no clip of its own opens over it', async () => {
  renderer.act(() => { tree = renderer.create(<Page lightbox={null} />); });
  await drawPreviews();
  const pagePlayer = playerOf(PAGE_CLIP)!;
  renderer.act(() => { pagePlayer.play(); });

  renderer.act(() => tree!.update(<Page lightbox={PICTURE} />));
  blurTheActivityWindow();

  expect(pagePlayer.playing).toBe(false);
  expect(players()).toHaveLength(1);
});

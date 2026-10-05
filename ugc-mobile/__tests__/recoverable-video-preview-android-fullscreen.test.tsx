import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

// A preview clip could not play in expo-video's fullscreen player on Android
// (Pixel 9a emulator, 2026-10-05). A press on the fullscreen button of a
// playing clip opened it paused, and every press on play there was taken back
// 6 ms later. The fullscreen player is another activity: starting it pauses
// the app's own, which React Native reports as `background`, and the preview
// took that for the app going away.
//
// This file renders the real preview and its real playback hook over a
// stand-in player and a stand-in for what the phone does around them. Each
// step of the stand-in is what the code on the phone does:
//
//   a press on fullscreen   VideoView.enterFullscreen marks its view as in
//                           fullscreen, starts the activity and sends
//                           onFullscreenEnter, which JS hears a frame later.
//   the app's activity      React Native says `background`
//   pauses                  (AppStateModule.onHostPause). expo-video stops
//                           every playing clip but one whose view is in
//                           fullscreen (VideoManager.onAppBackgrounded).
//   Home in fullscreen      FullscreenPlayerActivity.onPause stops a playing
//                           clip. The app's activity was paused already, so
//                           AppState says nothing.
//   BACK in fullscreen      the app's activity resumes (`active`), and only
//                           later is the fullscreen one destroyed: its view is
//                           then out of fullscreen and sends onFullscreenExit.
//   a clip out of data      it wants to play and is not playing. Nothing stops
//                           it when the app is left, and it starts when its
//                           data comes.

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type Listener = (event?: unknown) => void;
type StandInPlayer = {
  source: unknown; status: string; playing: boolean; wantsToPlay: boolean; currentTime: number;
  muted: boolean; volume: number; playbackRate: number; loop: boolean;
  /** What JS asks of the player. */
  play: Mock<() => void>; pause: Mock<() => void>; replaceAsync: Mock<(next: unknown) => Promise<void>>;
  addListener: (name: string, listener: Listener) => { remove: () => void };
  /** What the player's own controls and expo-video do to it, with no word from JS. */
  native: { play: () => void; pause: () => void; runOutOfData: () => void; dataArrives: () => void };
};

const state = vi.hoisted(() => ({
  os: 'android',
  focused: true,
  appState: 'active',
  viewInFullscreen: false,
  appListeners: new Map<string, Set<(event?: unknown) => void>>(),
  frames: [] as Array<() => void>,
  players: [] as unknown[],
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }));
vi.mock('@/lib/use-media-source', () => ({ useMediaSource: (url: string) => ({ source: { uri: url }, requestKey: '' }) }));
vi.mock('@/components/ui', () => ({ SecondaryButton: (props: MockProps) => React.createElement('retry-button', props) }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.os; } },
  AppState: {
    get currentState() { return state.appState; },
    addEventListener: (name: string, listener: (event?: unknown) => void) => {
      if (!state.appListeners.has(name)) state.appListeners.set(name, new Set());
      state.appListeners.get(name)!.add(listener);
      return { remove: () => { state.appListeners.get(name)?.delete(listener); } };
    },
  },
  Dimensions: { get: () => ({ width: 400, height: 800 }), addEventListener: () => ({ remove: vi.fn() }) },
  StyleSheet: { flatten: (style: unknown) => Object.assign({}, ...[style].flat()) },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  ActivityIndicator: (props: MockProps) => React.createElement('loading', props),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
  // As the phone's player answers: a request to play is kept while the clip is
  // not there yet and acted on when it arrives, and a pause takes it back.
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
      const want = (wanted: boolean) => { instance.wantsToPlay = wanted; settle(); };
      const instance = {
        source, status: source ? 'readyToPlay' : 'idle', playing: false, wantsToPlay: false, currentTime: 0,
        muted: false, volume: 1, playbackRate: 1, loop: false,
        play: vi.fn(() => want(true)),
        pause: vi.fn(() => want(false)),
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
        native: {
          play: () => want(true),
          pause: () => want(false),
          runOutOfData: () => { instance.status = 'loading'; emit('statusChange', { status: 'loading' }); settle(); },
          dataArrives: () => { instance.status = 'readyToPlay'; emit('statusChange', { status: 'readyToPlay' }); settle(); },
        },
      };
      state.players.push(instance);
      setup(instance);
      return instance;
    }, [JSON.stringify(source)]);
    return player;
  },
}));

import { RecoverableVideoPreview } from '@/components/recoverable-video-preview';

const CLIP = 'https://cdn.example.com/post.mp4';
let tree: renderer.ReactTestRenderer | undefined;
beforeEach(() => {
  state.os = 'android'; state.focused = true; state.appState = 'active'; state.viewInFullscreen = false;
  state.appListeners.clear(); state.frames = []; state.players = [];
  vi.stubGlobal('requestAnimationFrame', (frame: () => void) => state.frames.push(frame));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const preview = (autoPlay = false) => <RecoverableVideoPreview url={CLIP} style={{ height: 300 }} autoPlay={autoPlay} />;
const thePlayer = () => (state.players as StandInPlayer[])[state.players.length - 1];
const view = () => tree!.root.findByType('video-view' as never).props as { onFullscreenEnter: () => void; onFullscreenExit: () => void };
const appSays = (name: string, value?: string) => { [...(state.appListeners.get(name) ?? [])].forEach(listener => listener(value)); };

/** Lays the preview out and lets its view make its surface: Android gives a player its clip only then. */
async function draw() {
  await renderer.act(async () => {
    tree!.root.findAll(node => String(node.type) === 'view' && typeof node.props.onLayout === 'function').forEach(each => each.props.onLayout());
    for (let pass = 0; pass < 3; pass += 1) state.frames.splice(0).forEach(frame => frame());
  });
}

/** A preview on the page whose clip has loaded and waits for a press, as every preview but the lightbox's does. */
async function mountLoaded() {
  renderer.act(() => { tree = renderer.create(preview()); });
  await draw();
  return thePlayer();
}

/** A preview whose clip a press on its own play button has started. */
async function mountPlaying() {
  const player = await mountLoaded();
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(true);
  return player;
}

/** The app's activity pauses. JS can hear of it before or after expo-video has acted on it. */
function pauseAppActivity(heard: 'after expo-video' | 'before expo-video' = 'after expo-video') {
  const expoVideoActs = () => { if (!state.viewInFullscreen) (state.players as StandInPlayer[]).forEach(player => player.native.pause()); };
  renderer.act(() => {
    if (heard === 'after expo-video') expoVideoActs();
    state.appState = 'background';
    appSays('change', 'background');
    if (heard === 'before expo-video') expoVideoActs();
  });
}

function resumeAppActivity() {
  renderer.act(() => { state.appState = 'active'; appSays('change', 'active'); });
}

/** A press on the clip's own fullscreen button. JS can hear the view's event before or after the activity's pause. */
function pressFullscreen(viewHeard: 'first' | 'last' = 'last') {
  state.viewInFullscreen = true;
  if (viewHeard === 'first') renderer.act(() => view().onFullscreenEnter());
  pauseAppActivity();
  if (viewHeard === 'last') renderer.act(() => view().onFullscreenEnter());
  // The fullscreen activity's window takes the focus from the app's.
  renderer.act(() => appSays('blur'));
}

/** The fullscreen activity is destroyed, some time after the app's own is back in front. */
function destroyFullscreenActivity() {
  renderer.act(() => { state.viewInFullscreen = false; view().onFullscreenExit(); });
}

function backFromFullscreen() {
  resumeAppActivity();
  renderer.act(() => appSays('focus'));
  destroyFullscreenActivity();
}

/** Home while the fullscreen player is in front: only the player tells JS anything, and only if it was playing. */
function homeFromFullscreen() {
  renderer.act(() => (state.players as StandInPlayer[]).forEach(player => { if (player.playing) player.native.pause(); }));
}

it.each(['first', 'last'] as const)('keeps a clip playing as its fullscreen player opens (the view’s event heard %s)', async viewHeard => {
  const player = await mountPlaying();
  pressFullscreen(viewHeard);
  expect(player.pause).not.toHaveBeenCalled();
  expect(player.playing).toBe(true);
});

it('answers pause and play inside the fullscreen player', async () => {
  const player = await mountPlaying();
  pressFullscreen();
  renderer.act(() => player.native.pause());
  expect(player.playing).toBe(false);
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(true);
  expect(player.pause).not.toHaveBeenCalled();
});

it('starts a paused clip from inside the fullscreen player', async () => {
  const player = await mountLoaded();
  pressFullscreen();
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(true);
});

it('comes back from fullscreen as it was left', async () => {
  const player = await mountPlaying();
  pressFullscreen();
  backFromFullscreen();
  expect(player.playing).toBe(true);

  pressFullscreen();
  renderer.act(() => player.native.pause());
  backFromFullscreen();
  expect(player.playing).toBe(false);
  expect(player.pause).not.toHaveBeenCalled();
});

it('is stopped by Home in fullscreen, stays stopped on the way back, and plays again when pressed', async () => {
  const player = await mountPlaying();
  pressFullscreen();
  homeFromFullscreen();
  expect(player.playing).toBe(false);
  // Back through the app switcher: the fullscreen player is in front again, and nothing tells JS.
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(true);

  homeFromFullscreen();
  // Back through the app's icon: the fullscreen activity is closed and the app's own is in front.
  destroyFullscreenActivity();
  resumeAppActivity();
  expect(player.playing).toBe(false);
});

// After BACK the app's activity is in front before the fullscreen one is
// destroyed. Until then expo-video still counts the view as in fullscreen and
// leaves its clip playing when the app goes away, so the preview stops it.
it('stops when the app is left after fullscreen has closed and before its activity is destroyed', async () => {
  const player = await mountPlaying();
  pressFullscreen();
  resumeAppActivity();
  pauseAppActivity();
  expect(player.playing).toBe(false);
});

it.each(['after expo-video', 'before expo-video'] as const)('still stops a clip on the page when the app is left (JS hears of it %s)', async heard => {
  const player = await mountPlaying();
  pauseAppActivity(heard);
  expect(player.playing).toBe(false);
  resumeAppActivity();
  expect(player.playing).toBe(false);
});

it('takes back a request to play when the app is left before the clip has loaded', async () => {
  renderer.act(() => { tree = renderer.create(preview(true)); });
  const player = thePlayer();
  expect(player.wantsToPlay).toBe(true);
  pauseAppActivity();
  await draw();
  expect(player.playing).toBe(false);
});

it('stops a clip on the page that starts while the app is away', async () => {
  const player = await mountLoaded();
  pauseAppActivity();
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(false);
});

it('still stops a clip on the page when something comes over it', async () => {
  const player = await mountPlaying();
  // The notification shade, or a Modal of the app: the activity's window loses the focus.
  renderer.act(() => appSays('blur'));
  expect(player.playing).toBe(false);
});

// Seen on the emulator: a clip that had run out of data in fullscreen, Home,
// and its data let through four seconds later. It played behind the launcher
// until the app was opened again. Nothing tells JS that the fullscreen player
// was left, so a clip that has waited there does not start by itself.
it('does not start behind the launcher a clip that was waiting for data in fullscreen when the app was left', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
  const player = await mountPlaying();
  pressFullscreen();
  renderer.act(() => player.native.runOutOfData());
  homeFromFullscreen();
  now.mockReturnValue(5_000_000 + 4_000);
  renderer.act(() => player.native.dataArrives());
  expect(player.playing).toBe(false);
  // And when the person is still there, a press on play starts it.
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(true);
  now.mockRestore();
});

it('lets a clip in fullscreen go on by itself after a short wait for data, as after a seek', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
  const player = await mountPlaying();
  pressFullscreen();
  renderer.act(() => player.native.runOutOfData());
  now.mockReturnValue(5_000_000 + 400);
  renderer.act(() => player.native.dataArrives());
  expect(player.playing).toBe(true);
  expect(player.pause).not.toHaveBeenCalled();
  now.mockRestore();
});

it('lets a clip on the page go on by itself after a long wait for data', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
  const player = await mountPlaying();
  renderer.act(() => player.native.runOutOfData());
  now.mockReturnValue(5_000_000 + 20_000);
  renderer.act(() => player.native.dataArrives());
  expect(player.playing).toBe(true);
  now.mockRestore();
});

it('keeps a clip on a screen that is not in front from starting, in fullscreen as on the page', async () => {
  const player = await mountPlaying();
  pressFullscreen();
  state.focused = false;
  renderer.act(() => tree!.update(preview()));
  expect(player.playing).toBe(false);
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(false);
});

// The iPhone's fullscreen is in the app's own window, and AppState there
// speaks of the app alone.
it('still stops the clip when the app is left during iPhone fullscreen', async () => {
  state.os = 'ios';
  renderer.act(() => { tree = renderer.create(preview()); });
  const player = thePlayer();
  renderer.act(() => player.native.play());
  renderer.act(() => view().onFullscreenEnter());
  expect(player.playing).toBe(true);
  renderer.act(() => { state.appState = 'inactive'; appSays('change', 'inactive'); });
  expect(player.playing).toBe(false);
  renderer.act(() => player.native.play());
  expect(player.playing).toBe(false);
});

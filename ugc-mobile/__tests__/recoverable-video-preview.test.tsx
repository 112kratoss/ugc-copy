import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  initialStatus: 'loading',
  focused: true,
  os: 'ios',
  sourceVersion: 0,
  players: [] as Array<{
    source: unknown;
    status: string;
    currentTime: number;
    playing: boolean;
    muted: boolean;
    volume: number;
    playbackRate: number;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    replaceAsync: ReturnType<typeof vi.fn>;
    listener?: (event: { status: string }) => void;
  }>,
}));
vi.mock('@/lib/use-native-preview-playback', () => ({ useNativePreviewPlayback: () => ({ viewRef: { current: null }, onLayout: () => {}, onFullscreenEnter: () => {}, onFullscreenExit: () => {} }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }));
vi.mock('@/lib/use-media-source', () => ({ useMediaSource: (url: string) => ({ source: { uri: state.sourceVersion ? `${url}?version=${state.sourceVersion}` : url } }) }));
vi.mock('@/components/ui', () => ({ SecondaryButton: (props: object) => React.createElement('retry-button', props) }));
vi.mock('react-native', () => ({
  View: (props: object) => React.createElement('view', props),
  Text: (props: object) => React.createElement('text', props),
  ActivityIndicator: (props: object) => React.createElement('loading', props),
  Platform: { get OS() { return state.os; } },
}));
vi.mock('expo-video', () => ({
  VideoView: (props: object) => React.createElement('video', props),
  useVideoPlayer: (source: unknown, setup: (player: unknown) => void) => {
    const player = React.useMemo(() => {
      const instance = {
        source,
        currentTime: 0, playing: false, muted: false, volume: 1, playbackRate: 1,
        status: state.initialStatus, play: vi.fn(), pause: vi.fn(), release: vi.fn(), replaceAsync: vi.fn(async () => { instance.currentTime = 0; }),
        listener: undefined as ((event: { status: string }) => void) | undefined,
        addListener: (_name: string, listener: (event: { status: string }) => void) => {
          instance.listener = listener;
          return { remove: () => { instance.listener = undefined; } };
        },
      };
      state.players.push(instance);
      setup(instance);
      return instance;
    }, [JSON.stringify(source)]);
    React.useEffect(() => () => player.release(), [player]);
    return player;
  },
}));
import { RecoverableVideoPreview } from '../components/recoverable-video-preview';
let tree: renderer.ReactTestRenderer | undefined;
beforeEach(() => { state.initialStatus = 'loading'; state.focused = true; state.os = 'ios'; state.sourceVersion = 0; state.players = []; });
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; });
function mount(autoPlay = false) {
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} autoPlay={autoPlay} />); });
  return tree!;
}
it('shows loading feedback without starting a result preview automatically', () => {
  const view = mount();
  expect(view.root.findByType('loading' as never).props.accessibilityLabel).toBe('Loading video');
  expect(state.players[0].play).not.toHaveBeenCalled();
  renderer.act(() => state.players[0].listener?.({ status: 'readyToPlay' }));
  expect(view.root.findAllByType('loading' as never)).toHaveLength(0);
});
it('shows an error that occurred before the status listener attached', () => {
  state.initialStatus = 'error';
  expect(mount().root.findByType('retry-button' as never).props.label).toBe('Retry video');
});
it('releases a failed player and starts a fresh attempt on explicit retry', () => {
  const view = mount();
  const failed = state.players[0];
  renderer.act(() => failed.listener?.({ status: 'error' }));
  renderer.act(() => view.root.findByType('retry-button' as never).props.onPress());
  expect(failed.release).toHaveBeenCalledOnce();
  expect(state.players).toHaveLength(2);
  expect(state.players[1].play).toHaveBeenCalledOnce();
  expect(view.root.findAllByType('retry-button' as never)).toHaveLength(0);
});
it('leaves repeated failures actionable and makes no timer-driven attempts', () => {
  state.initialStatus = 'error';
  const view = mount();
  renderer.act(() => view.root.findByType('retry-button' as never).props.onPress());
  expect(view.root.findByType('retry-button' as never).props.label).toBe('Retry video');
  expect(state.players).toHaveLength(2);
});
it('preserves lightbox autoplay', () => {
  mount(true);
  expect(state.players[0].play).toHaveBeenCalledOnce();
});
// Android showed previous and next on the reference details player, one of them
// dead, because expo-video applies its documented defaults only once the prop
// is set (2026-10-04).
it('asks for no previous or next button, as each of these players holds one clip', () => {
  expect(mount().root.findByType('video' as never).props.buttonOptions).toEqual({ showPrevious: false, showNext: false });
});
// On Android an uncached looping player downloads its clip again for every
// repeat it buffers: five times for a paused 12s reference clip (2026-10-02).
it('reads a network clip through the video cache so its loops are not downloaded again', () => {
  mount();
  expect(state.players[0].source).toEqual({ uri: 'https://media.test/video.mp4', useCaching: true });
});
it('keeps reading through the cache when the effective URL renews', () => {
  const view = mount();
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />));
  expect(state.players[1].source).toEqual({ uri: 'https://media.test/video.mp4?version=1', useCaching: true });
});
it('plays a clip already on the device without copying it into the cache', () => {
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="file:///data/user/0/app/cache/picked.mp4" style={{ height: 300 }} />); });
  expect(state.players[0].source).toEqual({ uri: 'file:///data/user/0/app/cache/picked.mp4', useCaching: false });
});
// A capped player stops partway through the file and keeps its cache entry
// open, so a second player on the same clip (the details sheet over a tile, the
// lightbox over a result) downloads it again instead of reading the cache.
it('leaves the forward buffer uncapped so the download finishes and other players can read it', () => {
  mount();
  expect(state.players[0]).not.toHaveProperty('bufferOptions');
});
// On the S24 a finger on the clip of a video reference tile opened nothing,
// while its label and a picture tile did (2026-10-05). Without controls,
// expo-video's Android view keeps the touch and forwards it to JS with the
// finger's place inside the clip as its place on the page, so the tile's press
// target saw the finger leave on the first movement. Only a tap with no movement
// (`adb shell input tap`) got through, which is why device checks had missed it.
// The layout of touches does not run here: this holds the prop that keeps the
// player out of their way, and the press itself is checked on a device.
// The view the player sits in: the nearest host `view` above it.
function playerWrapper(view: renderer.ReactTestRenderer) {
  let node = view.root.findByType('video' as never).parent;
  while (node && String(node.type) !== 'view') node = node.parent;
  if (!node) throw new Error('the player has no view around it');
  return node;
}
it('lets touches pass a player that has no controls, so a press reaches what holds it', () => {
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 72 }} nativeControls={false} />); });
  expect(tree!.root.findByType('video' as never).props.nativeControls).toBe(false);
  const wrapper = playerWrapper(tree!);
  expect(wrapper.props.pointerEvents).toBe('none');
  // A real view, or the flattened hierarchy would hand the player its touches back.
  expect(wrapper.props.collapsable).toBe(false);
});
it('leaves a player with controls its own touches, and a failed one its retry', () => {
  const view = mount();
  expect(view.root.findByType('video' as never).props.nativeControls).toBe(true);
  expect(playerWrapper(view).props.pointerEvents).toBe('auto');

  state.initialStatus = 'error';
  renderer.act(() => tree?.unmount());
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 72 }} nativeControls={false} />); });
  // The retry card is beside the touch-transparent wrapper, not inside it.
  const wrapper = playerWrapper(tree!);
  expect(wrapper.props.pointerEvents).toBe('none');
  expect(wrapper.findAllByType('retry-button' as never)).toHaveLength(0);
  expect(tree!.root.findByType('retry-button' as never).props.label).toBe('Retry video');
});
it('pauses a retained screen on blur and does not resume it automatically on return', () => {
  const view = mount(true);
  const player = state.players[0];
  state.focused = false;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} autoPlay />));
  expect(player.pause).toHaveBeenCalledOnce();
  state.focused = true;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} autoPlay />));
  expect(state.players).toHaveLength(1);
  expect(player.play).toHaveBeenCalledOnce();
});
it('does not autoplay a replacement source on a hidden screen', () => {
  state.focused = false;
  mount(true);
  expect(state.players[0].play).not.toHaveBeenCalled();
  expect(state.players[0].pause).toHaveBeenCalledOnce();
});
it('does not carry a previous retry autoplay decision into a different result', () => {
  state.initialStatus = 'error';
  const view = mount();
  renderer.act(() => view.root.findByType('retry-button' as never).props.onPress());
  state.initialStatus = 'loading';
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/another.mp4" style={{ height: 300 }} />));
  expect(state.players[2].play).not.toHaveBeenCalled();
  expect(view.root.findAllByType('retry-button' as never)).toHaveLength(0);
});

it('preserves pause, position and audio settings when the effective URL renews', () => {
  const view = mount(true);
  const original = state.players[0];
  Object.assign(original, { status: 'readyToPlay', currentTime: 12.5, playing: false, muted: true, volume: 0.4, playbackRate: 1.5 });
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} autoPlay />));
  expect(original.release).toHaveBeenCalledOnce();
  expect(state.players[1]).toMatchObject({ currentTime: 12.5, muted: true, volume: 0.4, playbackRate: 1.5 });
  expect(state.players[1].play).not.toHaveBeenCalled();
  expect(state.players[1].pause).toHaveBeenCalledOnce();
});

it('continues a manually started preview from its position after source renewal', () => {
  const view = mount();
  Object.assign(state.players[0], { currentTime: 9, playing: true });
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />));
  expect(state.players[1].currentTime).toBe(9);
  expect(state.players[1].play).toHaveBeenCalledOnce();
});

it('keeps an autoplay request when the source renews before the first frame', () => {
  const view = mount(true);
  expect(state.players[0].status).toBe('loading');
  expect(state.players[0].playing).toBe(false);
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} autoPlay />));
  expect(state.players[1].play).toHaveBeenCalledOnce();
  expect(state.players[1].pause).not.toHaveBeenCalled();
});

it('leaves a still-loading result preview paused on renewal when nothing requested playback', () => {
  const view = mount();
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />));
  expect(state.players[1].play).not.toHaveBeenCalled();
  expect(state.players[1].pause).toHaveBeenCalledOnce();
});

it('does not resume a playing source renewed while its screen is hidden', () => {
  const view = mount();
  Object.assign(state.players[0], { currentTime: 9, playing: true });
  state.focused = false;
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />));
  expect(state.players[1].currentTime).toBe(9);
  expect(state.players[1].play).not.toHaveBeenCalled();
});

it('renews once before replacing a failed player and ignores repeated presses while pending', async () => {
  state.initialStatus = 'error';
  let finish: (url: string) => void = () => undefined;
  const resolveRetryUrl = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/expired.mp4" style={{ height: 300 }} resolveRetryUrl={resolveRetryUrl} />); });
  const press = tree!.root.findByType('retry-button' as never).props.onPress;
  renderer.act(() => { press(); press(); });
  expect(resolveRetryUrl).toHaveBeenCalledOnce();
  expect(state.players).toHaveLength(1);
  expect(tree!.root.findByType('retry-button' as never).props.disabled).toBe(true);
  expect(tree!.root.findByType('retry-button' as never).props.label).toBe('Refreshing video…');
  state.initialStatus = 'readyToPlay';
  await renderer.act(async () => { finish('https://media.test/renewed.mp4'); });
  expect(state.players[0].release).toHaveBeenCalledOnce();
  expect(state.players[1].source).toEqual({ uri: 'https://media.test/renewed.mp4', useCaching: true });
  expect(state.players[1].play).toHaveBeenCalledOnce();
});

it('shows renewal failure without replaying the stale source and permits another retry', async () => {
  state.initialStatus = 'error';
  const resolveRetryUrl = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce('https://media.test/new.mp4');
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/expired.mp4" style={{ height: 300 }} resolveRetryUrl={resolveRetryUrl} />); });
  await renderer.act(async () => { tree!.root.findByType('retry-button' as never).props.onPress(); });
  expect(state.players).toHaveLength(1);
  expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe('Couldn’t refresh video. Try again.');
  await renderer.act(async () => { tree!.root.findByType('retry-button' as never).props.onPress(); });
  expect(state.players).toHaveLength(2);
});

it('ignores renewal completing after the selected source changes', async () => {
  state.initialStatus = 'error';
  let finish: (url: string) => void = () => undefined;
  const resolveRetryUrl = () => new Promise<string>(resolve => { finish = resolve; });
  renderer.act(() => { tree = renderer.create(<RecoverableVideoPreview url="https://media.test/old.mp4" style={{ height: 300 }} resolveRetryUrl={resolveRetryUrl} />); });
  renderer.act(() => { tree!.root.findByType('retry-button' as never).props.onPress(); });
  renderer.act(() => { tree!.update(<RecoverableVideoPreview url="https://media.test/other.mp4" style={{ height: 300 }} />); });
  await renderer.act(async () => { finish('https://media.test/late.mp4'); });
  expect(state.players).toHaveLength(2);
  expect(state.players[1].source).toEqual({ uri: 'https://media.test/other.mp4', useCaching: true });
  expect(state.players[1].play).not.toHaveBeenCalled();
});
it('turns a stalled native load into an actionable retry after 30 seconds', () => {
  vi.useFakeTimers();
  try {
    const view = mount();
    renderer.act(() => { vi.advanceTimersByTime(30_000); });
    expect(view.root.findByType('retry-button' as never).props.label).toBe('Retry video');
    expect(view.root.findAllByType('loading' as never)).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});
it('clears the load deadline once native playback is ready', () => {
  vi.useFakeTimers();
  try {
    const view = mount();
    renderer.act(() => { vi.advanceTimersByTime(20_000); state.players[0].listener?.({ status: 'readyToPlay' }); });
    renderer.act(() => { vi.advanceTimersByTime(30_000); });
    expect(view.root.findAllByType('retry-button' as never)).toHaveLength(0);
  } finally { vi.useRealTimers(); }
});

// On Android a paused clip came up with its controls and duration and no
// picture, and stayed that way: 5 mounts in 102 on the Pixel_9a emulator
// (2026-10-05). The player was loading before its view existed, so the decoder
// started on a placeholder surface and was moved to the view's a few
// milliseconds later, and a frame in flight during the move was dropped with
// only a log line (`rendring output error -32`). The player reports that frame
// as rendered all the same. Nothing here can lose a frame, so these hold the
// order that keeps the move from happening: the view first, then the clip.
const CLIP = { uri: 'https://media.test/video.mp4', useCaching: true };
/** The view the preview is drawn in: its layout is what the clip waits for. */
function frameOf(view: renderer.ReactTestRenderer) {
  return view.root.findAllByType('view' as never)[0];
}
function nextFrame() {
  renderer.act(() => { vi.advanceTimersByTime(16); });
}
function withFrames(run: () => void | Promise<void>) {
  return async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    try {
      state.os = 'android';
      await run();
    } finally {
      renderer.act(() => tree?.unmount());
      tree = undefined;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  };
}
it('on Android makes the player empty and gives it its clip two frames after its view is laid out', withFrames(() => {
  const view = mount();
  const player = state.players[0];
  expect(player.source).toBeNull();
  // Not on a timer, and not before there is a view to make a surface in.
  renderer.act(() => { vi.advanceTimersByTime(1_000); });
  expect(player.replaceAsync).not.toHaveBeenCalled();
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  expect(player.replaceAsync).not.toHaveBeenCalled();
  nextFrame();
  expect(player.replaceAsync.mock.calls).toEqual([[CLIP]]);
  expect(state.players).toHaveLength(1);
}));
it('gives the clip once, however often the view is laid out', withFrames(() => {
  const view = mount();
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  expect(state.players[0].replaceAsync).toHaveBeenCalledOnce();
}));
it('gives nothing to a player whose preview is gone before the frames have passed', withFrames(() => {
  const view = mount();
  const player = state.players[0];
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  renderer.act(() => tree?.unmount());
  tree = undefined;
  nextFrame();
  nextFrame();
  expect(player.replaceAsync).not.toHaveBeenCalled();
}));
it('keeps an autoplay request made before the clip arrives', withFrames(() => {
  const view = mount(true);
  expect(state.players[0].play).toHaveBeenCalledOnce();
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  expect(state.players[0].replaceAsync.mock.calls).toEqual([[CLIP]]);
  expect(state.players[0].pause).not.toHaveBeenCalled();
}));
// A new player for a renewed link would start loading before the view has
// handed it the surface, which is the race over again.
it('on Android hands a renewed link to the same player, which keeps its place', withFrames(async () => {
  const view = mount();
  const player = state.players[0];
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  Object.assign(player, { status: 'readyToPlay', currentTime: 12.5, muted: true, volume: 0.4 });
  state.sourceVersion = 1;
  await renderer.act(async () => { view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />); });
  expect(state.players).toHaveLength(1);
  expect(player.release).not.toHaveBeenCalled();
  expect(player.replaceAsync).toHaveBeenLastCalledWith({ uri: 'https://media.test/video.mp4?version=1', useCaching: true });
  expect(player).toMatchObject({ currentTime: 12.5, muted: true, volume: 0.4 });
  expect(player.play).not.toHaveBeenCalled();
}));
it('uses the newest link when it is renewed before the view is ready', withFrames(() => {
  const view = mount();
  state.sourceVersion = 1;
  renderer.act(() => view.update(<RecoverableVideoPreview url="https://media.test/video.mp4" style={{ height: 300 }} />));
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  expect(state.players[0].replaceAsync.mock.calls).toEqual([[{ uri: 'https://media.test/video.mp4?version=1', useCaching: true }]]);
}));
it('leaves an iPhone’s player as it was: made with its clip, and not given it again', withFrames(() => {
  state.os = 'ios';
  const view = mount();
  expect(state.players[0].source).toEqual(CLIP);
  renderer.act(() => frameOf(view).props.onLayout());
  nextFrame();
  nextFrame();
  expect(state.players[0].replaceAsync).not.toHaveBeenCalled();
}));

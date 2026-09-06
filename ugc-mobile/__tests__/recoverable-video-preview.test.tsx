import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  initialStatus: 'loading',
  focused: true,
  players: [] as Array<{
    source: unknown;
    status: string;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    listener?: (event: { status: string }) => void;
  }>,
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }));
vi.mock('@/lib/use-media-source', () => ({ useMediaSource: (url: string) => ({ source: { uri: url } }) }));
vi.mock('@/components/ui', () => ({ SecondaryButton: (props: object) => React.createElement('retry-button', props) }));
vi.mock('react-native', () => ({
  View: (props: object) => React.createElement('view', props),
  Text: (props: object) => React.createElement('text', props),
  ActivityIndicator: (props: object) => React.createElement('loading', props),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: object) => React.createElement('video', props),
  useVideoPlayer: (source: unknown, setup: (player: unknown) => void) => {
    const [player] = React.useState(() => {
      const instance = {
        source,
        status: state.initialStatus, play: vi.fn(), pause: vi.fn(), release: vi.fn(),
        listener: undefined as ((event: { status: string }) => void) | undefined,
        addListener: (_name: string, listener: (event: { status: string }) => void) => {
          instance.listener = listener;
          return { remove: () => { instance.listener = undefined; } };
        },
      };
      state.players.push(instance);
      setup(instance);
      return instance;
    });
    React.useEffect(() => () => player.release(), [player]);
    return player;
  },
}));
import { RecoverableVideoPreview } from '../components/recoverable-video-preview';
let tree: renderer.ReactTestRenderer | undefined;
beforeEach(() => { state.initialStatus = 'loading'; state.focused = true; state.players = []; });
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
  expect(state.players[1].source).toEqual({ uri: 'https://media.test/renewed.mp4' });
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
  expect(state.players[1].source).toEqual({ uri: 'https://media.test/other.mp4' });
  expect(state.players[1].play).not.toHaveBeenCalled();
});

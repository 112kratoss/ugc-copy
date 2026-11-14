import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ platform: 'ios', currentState: 'active', appListeners: new Map<string, (state: string) => void>(), scroll: null as null | (() => void), y: 100, measurements: 0 }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.platform; } },
  AppState: { get currentState() { return state.currentState; }, addEventListener: (name: string, callback: (state: string) => void) => { state.appListeners.set(name, callback); return { remove: () => state.appListeners.delete(name) }; } },
  Dimensions: { get: () => ({ width: 400, height: 800 }), addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock('@/components/media-viewport-scroll-view', async () => ({ MediaViewportContext: (await import('react')).createContext({
  subscribe(callback: () => void) { state.scroll = callback; return () => { state.scroll = null; }; },
  measure(callback: (rect: object) => void) { callback({ x: 0, y: 80, width: 400, height: 700 }); },
}) }));
import { ModalWindowScope } from '../lib/modal-window';
import { useNativePreviewPlayback } from '../lib/use-native-preview-playback';
let tree: renderer.ReactTestRenderer | undefined;
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; state.currentState = 'active'; state.platform = 'ios'; state.y = 100; state.measurements = 0; });
function mount(inModal = false) {
  let event!: (value: { isPlaying: boolean }) => void;
  const player = { playing: true, pause: vi.fn(() => { player.playing = false; }), addListener: vi.fn((name: string, callback: typeof event) => { if (name === 'playingChange') event = callback; return { remove: vi.fn() }; }) };
  let result!: ReturnType<typeof useNativePreviewPlayback>;
  function Harness() { result = useNativePreviewPlayback(player as never, true); result.viewRef.current = { measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) { state.measurements++; callback(0, state.y, 300, 220); } } as never; return null; }
  renderer.act(() => { tree = renderer.create(inModal ? <ModalWindowScope><Harness /></ModalWindowScope> : <Harness />); });
  return { player, event: () => event({ isPlaying: true }), controls: () => result };
}
it('checks playing previews on scroll and does no work for paused scrolling', () => {
  const { player } = mount(); expect(player.pause).not.toHaveBeenCalled();
  state.y = -300; state.scroll?.(); expect(player.pause).toHaveBeenCalledOnce();
  const count = state.measurements; state.y = 100; state.scroll?.();
  expect(state.measurements).toBe(count); expect(player.playing).toBe(false);
});
it('pauses on app-state notifications and rejects background play requests', () => {
  const { player, event } = mount();
  state.currentState = 'background'; state.appListeners.get('change')?.('background'); expect(player.playing).toBe(false);
  player.playing = true; event(); expect(player.playing).toBe(false);
  state.currentState = 'active'; state.appListeners.get('change')?.('active'); expect(player.playing).toBe(false);
});
it('allows native fullscreen until it exits to an offscreen inline view', () => {
  const { player, controls } = mount(); controls().onFullscreenEnter(); state.y = -300; state.scroll?.(); expect(player.playing).toBe(true);
  controls().onFullscreenExit(); expect(player.playing).toBe(false);
});

// expo-video's fullscreen player on Android is another activity. Starting it
// pauses the app's own, which React Native reports as `background`, and takes
// the focus from its window (`blur`). A preview clip could not play there
// (Pixel 9a emulator, 2026-10-05): it was paused as fullscreen opened, and
// again 6 ms after every press on play.
const leaveApp = () => { state.currentState = 'background'; state.appListeners.get('change')?.('background'); };
const returnToApp = () => { state.currentState = 'active'; state.appListeners.get('change')?.('active'); };
const loseWindowFocus = () => state.appListeners.get('blur')?.('');
// The view's event and the activity's pause reach JS by different roads (the
// event waits for the next frame), so either can be heard first.
it.each(['before', 'after'])('keeps a clip playing as its Android fullscreen player opens, the view heard %s the activity pauses', heard => {
  state.platform = 'android'; const { player, controls } = mount();
  if (heard === 'before') controls().onFullscreenEnter();
  leaveApp();
  if (heard === 'after') controls().onFullscreenEnter();
  loseWindowFocus(); expect(player.pause).not.toHaveBeenCalled();
});
it('lets play answer inside the Android fullscreen player', () => {
  state.platform = 'android'; const { player, event, controls } = mount();
  controls().onFullscreenEnter(); leaveApp(); loseWindowFocus();
  player.playing = false; player.playing = true; event(); expect(player.pause).not.toHaveBeenCalled();
});
it('goes back to the page’s rules once the Android fullscreen player has closed', () => {
  state.platform = 'android'; const { player, controls } = mount();
  controls().onFullscreenEnter(); leaveApp(); returnToApp(); controls().onFullscreenExit(); expect(player.playing).toBe(true);
  loseWindowFocus(); expect(player.playing).toBe(false);
});
// The app's activity is back in front before the fullscreen one is destroyed,
// and until then expo-video still counts the view as in fullscreen and would
// leave its clip playing as the app goes away.
it('pauses when the app is left after Android fullscreen has closed but before its activity is gone', () => {
  state.platform = 'android'; const { player, controls } = mount();
  controls().onFullscreenEnter(); leaveApp(); returnToApp();
  leaveApp(); expect(player.playing).toBe(false);
});
it('takes back a request to play when the app is left on Android, and stops a clip that starts there', () => {
  state.platform = 'android'; const { player, event } = mount();
  player.playing = false; leaveApp(); expect(player.pause).toHaveBeenCalledOnce();
  player.playing = true; event(); expect(player.playing).toBe(false);
});
// A clip that runs out of data and waits goes on by itself when the data comes,
// however long it waited, on the page and in fullscreen alike. Leaving the app
// from Android's fullscreen player, which JS cannot hear, stops a waiting clip
// natively in every build from 0.1.9 (patches/expo-video+55.0.21+006); until
// then the hook held such a clip for a press after a two-second wait.
type Waiting = { status: string; playing: boolean };
const runOutOfData = (player: Waiting, stopped: () => void) => { player.status = 'loading'; player.playing = false; stopped(); };
const dataArrives = (player: Waiting) => { player.status = 'readyToPlay'; };
function mountWaiting(platform: string, inFullscreen: boolean) {
  state.platform = platform; const mounted = mount(); const player = mounted.player as never as Waiting;
  const stopped = () => (mounted.player.addListener.mock.calls.find(([name]) => name === 'playingChange')![1] as never as (event: { isPlaying: boolean }) => void)({ isPlaying: false });
  if (inFullscreen) { mounted.controls().onFullscreenEnter(); if (platform === 'android') leaveApp(); }
  runOutOfData(player, stopped);
  return { ...mounted, waiting: player };
}
it.each([['android', true], ['android', false], ['ios', true]] as const)('lets a clip go on by itself after a wait for data (%s, fullscreen %s)', (platform, inFullscreen) => {
  const { player, waiting, event } = mountWaiting(platform, inFullscreen);
  dataArrives(waiting); player.playing = true; event(); expect(player.pause).not.toHaveBeenCalled();
});
it('listens for nothing but play and pause on the player', () => {
  const { player } = mount();
  expect(player.addListener.mock.calls.map(([name]) => name)).toEqual(['playingChange']);
});
it('still pauses when the app is left during iPhone fullscreen, which is in the app’s own window', () => {
  const { player, event, controls } = mount(); controls().onFullscreenEnter();
  leaveApp(); expect(player.playing).toBe(false);
  player.playing = true; event(); expect(player.playing).toBe(false);
});
it('unsubscribes scroll and app events on unmount', () => {
  mount(); renderer.act(() => tree?.unmount()); tree = undefined; expect(state.scroll).toBeNull(); expect(state.appListeners.size).toBe(0);
});

it('subscribes to notification blur only on Android', () => {
  mount(); expect(state.appListeners.has('blur')).toBe(false);
  renderer.act(() => tree?.unmount()); tree = undefined;
  state.platform = 'android'; const { player } = mount();
  state.appListeners.get('blur')?.(''); expect(player.playing).toBe(false);
});

// On Android a Modal is a second window, and `blur` is the activity's window
// losing the focus: to the notification shade, and to every Modal as it opens.
// The lightbox's clip was paused by the lightbox's own opening (2026-10-05).
it('pauses a preview on the page when the activity window loses the focus, and leaves one inside a Modal playing', () => {
  state.platform = 'android';
  const page = mount();
  state.appListeners.get('blur')?.(''); expect(page.player.pause).toHaveBeenCalledOnce();
  renderer.act(() => tree?.unmount()); tree = undefined;
  const lightbox = mount(true);
  expect(state.appListeners.has('blur')).toBe(false); expect(lightbox.player.playing).toBe(true);
});
// A clip that is playing as the app leaves is stopped by expo-video itself, as
// the activity pauses and before JS hears of it (VideoManager.onAppBackgrounded;
// seen on the emulator for a page, a sheet, the lightbox and the result). What
// is left to the preview, inside a Modal as on the page, is the clip that is
// not playing yet.
it('still keeps a preview inside a Modal from starting when the app has left the foreground', () => {
  state.platform = 'android';
  const { player, event } = mount(true);
  player.playing = false; leaveApp(); expect(player.pause).toHaveBeenCalledOnce();
  player.playing = true; event(); expect(player.playing).toBe(false);
});

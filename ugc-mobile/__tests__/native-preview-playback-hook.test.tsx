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
// Nothing tells JS that the app was left while the fullscreen player was in
// front: the app's own activity was paused already. expo-video stops a clip
// there only if it is playing at that moment, so one that was waiting for data
// started when the data came, behind the launcher (emulator, 2026-10-05).
type Waiting = { status: string; playing: boolean; addListener: { mock: { calls: Array<[string, (event: { status: string }) => void]> } } };
const runOutOfData = (player: Waiting, stopped: () => void) => { player.status = 'loading'; player.playing = false; stopped(); };
const dataArrives = (player: Waiting) => { player.status = 'readyToPlay'; player.addListener.mock.calls.find(([name]) => name === 'statusChange')?.[1]({ status: 'readyToPlay' }); };
function mountWaiting(platform: string, inFullscreen: boolean, waitMs: number) {
  state.platform = platform; const mounted = mount(); const player = mounted.player as never as Waiting;
  const stopped = () => (mounted.player.addListener.mock.calls.find(([name]) => name === 'playingChange')![1] as never as (event: { isPlaying: boolean }) => void)({ isPlaying: false });
  if (inFullscreen) { mounted.controls().onFullscreenEnter(); if (platform === 'android') leaveApp(); }
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  runOutOfData(player, stopped); now.mockReturnValue(1_000_000 + waitMs);
  return { ...mounted, waiting: player, restore: () => now.mockRestore() };
}
it('does not let a clip start by itself behind its Android fullscreen player after a long wait for data, and lets a press start it', () => {
  const { player, waiting, event, restore } = mountWaiting('android', true, 8000);
  dataArrives(waiting); expect(player.pause).toHaveBeenCalledOnce();
  player.playing = true; event(); expect(player.playing).toBe(true); restore();
});
it('stops such a clip when its start is heard before its data', () => {
  const { player, event, restore } = mountWaiting('android', true, 8000);
  player.playing = true; event(); expect(player.playing).toBe(false); restore();
});
it('lets a clip go on by itself behind its Android fullscreen player after a short wait, as after a seek', () => {
  const { player, waiting, event, restore } = mountWaiting('android', true, 600);
  dataArrives(waiting); player.playing = true; event(); expect(player.pause).not.toHaveBeenCalled(); restore();
});
it.each([['android', false], ['ios', true]] as const)('lets a clip go on by itself after a long wait where the app can tell it is in front (%s, fullscreen %s)', (platform, inFullscreen) => {
  const { player, waiting, event, restore } = mountWaiting(platform, inFullscreen, 8000);
  dataArrives(waiting); player.playing = true; event(); expect(player.pause).not.toHaveBeenCalled(); restore();
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

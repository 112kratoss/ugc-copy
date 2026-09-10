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
import { useNativePreviewPlayback } from '../lib/use-native-preview-playback';
let tree: renderer.ReactTestRenderer | undefined;
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; state.currentState = 'active'; state.platform = 'ios'; state.y = 100; state.measurements = 0; });
function mount() {
  let event!: (value: { isPlaying: boolean }) => void;
  const player = { playing: true, pause: vi.fn(() => { player.playing = false; }), addListener: vi.fn((_name: string, callback: typeof event) => { event = callback; return { remove: vi.fn() }; }) };
  let result!: ReturnType<typeof useNativePreviewPlayback>;
  function Harness() { result = useNativePreviewPlayback(player as never, true); result.viewRef.current = { measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) { state.measurements++; callback(0, state.y, 300, 220); } } as never; return null; }
  renderer.act(() => { tree = renderer.create(<Harness />); });
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
it('unsubscribes scroll and app events on unmount', () => {
  mount(); renderer.act(() => tree?.unmount()); tree = undefined; expect(state.scroll).toBeNull(); expect(state.appListeners.size).toBe(0);
});

it('subscribes to notification blur only on Android', () => {
  mount(); expect(state.appListeners.has('blur')).toBe(false);
  renderer.act(() => tree?.unmount()); tree = undefined;
  state.platform = 'android'; const { player } = mount();
  state.appListeners.get('blur')?.(''); expect(player.playing).toBe(false);
});

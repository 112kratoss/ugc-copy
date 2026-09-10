import React, { createRef } from 'react';
import renderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';
const { listeners } = vi.hoisted(() => ({ listeners: new Map<string, (state?: string) => void>() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: (name: string, fn: (state?: string) => void) => {
    listeners.set(name, fn); return { remove: () => listeners.delete(name) };
  } },
}));
import { useViewerPlaybackGate } from '../lib/use-viewer-playback-gate';
let tree: renderer.ReactTestRenderer | undefined;
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; listeners.clear(); });
it('keeps playback revoked on return and pauses the current replacement player', () => {
  const first = { pause: vi.fn() }, next = { pause: vi.fn() }, revoked = vi.fn();
  const player = createRef<VideoPlayer>(); player.current = first as never;
  let gate: { current: boolean };
  function Probe() { gate = useViewerPlaybackGate(player, revoked); return null; }
  renderer.act(() => { tree = renderer.create(<Probe />); });
  expect(gate!.current).toBe(true); expect(revoked).not.toHaveBeenCalled();
  renderer.act(() => listeners.get('change')?.('background'));
  expect(first.pause).toHaveBeenCalledOnce(); expect(gate!.current).toBe(false);
  expect(revoked).toHaveBeenCalledOnce(); // a loading player emits no playingChange, so the badge needs this
  player.current = next as never;
  renderer.act(() => listeners.get('change')?.('active'));
  expect(next.pause).toHaveBeenCalledOnce(); expect(gate!.current).toBe(false);
  expect(revoked).toHaveBeenCalledOnce();
  gate!.current = true; // Explicit Play grants playback again.
  renderer.act(() => listeners.get('change')?.('active'));
  expect(next.pause).toHaveBeenCalledOnce();
});
it('revokes playback on Android window blur and removes listeners on unmount', () => {
  const instance = { pause: vi.fn() }, player = createRef<VideoPlayer>(); player.current = instance as never;
  let gate: { current: boolean };
  function Probe() { gate = useViewerPlaybackGate(player); return null; }
  renderer.act(() => { tree = renderer.create(<Probe />); });
  renderer.act(() => listeners.get('blur')?.());
  expect(instance.pause).toHaveBeenCalledOnce(); expect(gate!.current).toBe(false);
  renderer.act(() => { tree!.unmount(); tree = undefined; });
  expect(listeners.size).toBe(0);
});

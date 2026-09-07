import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { useVideoLoadDeadline } from '../lib/use-video-load-deadline';
import type { VideoPlayerStatus } from 'expo-video';
let tree: renderer.ReactTestRenderer | undefined;
afterEach(() => { renderer.act(() => tree?.unmount()); tree = undefined; vi.useRealTimers(); });
const makePlayer = () => ({ pause: vi.fn(), replaceAsync: vi.fn(async () => {}) });
it('makes a stalled source actionable once and clears the transport', () => {
  vi.useFakeTimers(); const player = makePlayer(); let timedOut = false;
  function Probe() { timedOut = useVideoLoadDeadline(player as never, 'loading'); return null; }
  renderer.act(() => { tree = renderer.create(<Probe />); vi.advanceTimersByTime(0); });
  renderer.act(() => { vi.advanceTimersByTime(29_999); }); expect(timedOut).toBe(false);
  renderer.act(() => { vi.advanceTimersByTime(1); }); expect(timedOut).toBe(true);
  renderer.act(() => { vi.advanceTimersByTime(60_000); });
  expect(player.pause).toHaveBeenCalledOnce(); expect(player.replaceAsync).toHaveBeenCalledExactlyOnceWith(null);
});
it('cancels when ready and gives a replacement player a fresh budget', () => {
  vi.useFakeTimers(); const first = makePlayer(), second = makePlayer(); let timedOut = false;
  function Probe({ player, status }: { player: typeof first; status: VideoPlayerStatus }) { timedOut = useVideoLoadDeadline(player as never, status); return null; }
  renderer.act(() => { tree = renderer.create(<Probe player={first} status="loading" />); });
  renderer.act(() => { vi.advanceTimersByTime(20_000); tree!.update(<Probe player={first} status="readyToPlay" />); });
  renderer.act(() => { vi.advanceTimersByTime(60_000); }); expect(first.pause).not.toHaveBeenCalled();
  renderer.act(() => { tree!.update(<Probe player={second} status="loading" />); }); expect(timedOut).toBe(false);
  renderer.act(() => { vi.advanceTimersByTime(30_000); }); expect(timedOut).toBe(true); expect(second.pause).toHaveBeenCalledOnce();
});
it('cleans up a pending deadline on unmount', () => {
  vi.useFakeTimers(); const player = makePlayer();
  function Probe() { useVideoLoadDeadline(player as never, 'loading'); return null; }
  renderer.act(() => { tree = renderer.create(<Probe />); });
  renderer.act(() => { tree!.unmount(); tree = undefined; });
  renderer.act(() => { vi.advanceTimersByTime(30_000); }); expect(player.pause).not.toHaveBeenCalled();
});

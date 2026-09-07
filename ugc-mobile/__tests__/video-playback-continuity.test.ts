import { expect, it, vi } from 'vitest';
import { restoreVideoPlayback } from '../lib/video-playback-continuity';
const player = () => ({ currentTime: 0, playing: false, status: 'readyToPlay', muted: false, volume: 1, playbackRate: 1, play: vi.fn(), pause: vi.fn() });
it('preserves a paused position and audio settings across renewal despite autoplay', () => {
  const previous = { ...player(), currentTime: 23, muted: true, volume: 0.4, playbackRate: 0.75 };
  const next = player(); restoreVideoPlayback(next as never, previous as never, true, true);
  expect(next).toMatchObject({ currentTime: 23, muted: true, volume: 0.4, playbackRate: 0.75 });
  expect(next.play).not.toHaveBeenCalled(); expect(next.pause).toHaveBeenCalledOnce();
});
it('continues manually started playback from its position', () => {
  const previous = { ...player(), playing: true, currentTime: 19 };
  const next = player(); restoreVideoPlayback(next as never, previous as never, false, true);
  expect(next.currentTime).toBe(19); expect(next.play).toHaveBeenCalledOnce();
});
it('keeps renewed media paused when playback is blocked by background or reduced motion', () => {
  const next = player(); restoreVideoPlayback(next as never, { ...player(), playing: true, currentTime: 12 } as never, true, false);
  expect(next.currentTime).toBe(12); expect(next.play).not.toHaveBeenCalled(); expect(next.pause).toHaveBeenCalledOnce();
});
it('applies initial autoplay only to a new item or explicit retry', () => {
  const next = player(); restoreVideoPlayback(next as never, null, true, true);
  expect(next.play).toHaveBeenCalledOnce(); expect(next.currentTime).toBe(0);
});
it('keeps a pending playback request when renewal lands before the first frame', () => {
  const previous = { ...player(), status: 'loading' };
  const next = player();
  expect(restoreVideoPlayback(next as never, previous as never, true, true)).toBe(true);
  expect(next.play).toHaveBeenCalledOnce(); expect(next.pause).not.toHaveBeenCalled();
});
it('resumes a failed player on renewal only while playback is still allowed', () => {
  const failed = { ...player(), status: 'error', currentTime: 7 };
  const resumed = player();
  expect(restoreVideoPlayback(resumed as never, failed as never, true, true)).toBe(true);
  expect(resumed.currentTime).toBe(7); expect(resumed.play).toHaveBeenCalledOnce();
  const held = player();
  expect(restoreVideoPlayback(held as never, failed as never, true, false)).toBe(false);
  expect(held.play).not.toHaveBeenCalled(); expect(held.pause).toHaveBeenCalledOnce();
});
it('reports a ready-and-paused player as a pause the caller can mirror', () => {
  expect(restoreVideoPlayback(player() as never, { ...player(), currentTime: 3 } as never, true, true)).toBe(false);
});

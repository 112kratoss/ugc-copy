import { expect, it, vi } from 'vitest';
import { restoreVideoPlayback } from '../lib/video-playback-continuity';
const player = () => ({ currentTime: 0, playing: false, muted: false, volume: 1, playbackRate: 1, play: vi.fn(), pause: vi.fn() });
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

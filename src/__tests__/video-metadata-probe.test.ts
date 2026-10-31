import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readVideoDurationSeconds } from '@/lib/video-metadata-probe';
let video: HTMLVideoElement;
beforeEach(() => {
  vi.useFakeTimers();
  video = document.createElement('video');
  vi.spyOn(document, 'createElement').mockReturnValue(video);
  vi.spyOn(video, 'load').mockImplementation(() => {});
  vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:probe'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('releases a stalled file probe within four seconds', async () => {
  const result = readVideoDurationSeconds(new File(['fixture'], 'video.mp4', { type: 'video/mp4' }));
  await vi.advanceTimersByTimeAsync(4000);
  expect(await result).toBeNull();
  expect(video).not.toHaveAttribute('src');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:probe');
});
it('settles once on metadata and ignores late errors', async () => {
  Object.defineProperty(video, 'duration', { configurable: true, value: 12 });
  const result = readVideoDurationSeconds('/video.mp4');
  video.dispatchEvent(new Event('loadedmetadata'));
  video.dispatchEvent(new Event('error'));
  expect(await result).toBe(12);
  expect(video.load).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels stale source probes and rejects non-finite metadata', async () => {
  const controller = new AbortController();
  const first = readVideoDurationSeconds('/first.mp4', controller.signal);
  controller.abort();
  expect(await first).toBeNull();
  Object.defineProperty(video, 'duration', { configurable: true, value: Infinity });
  const second = readVideoDurationSeconds('/second.mp4');
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(await second).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('reads a QuickTime clip whose type canPlayType disowns, as Chrome does', async () => {
  vi.mocked(video.canPlayType).mockReturnValue('');
  Object.defineProperty(video, 'duration', { configurable: true, value: 2 });
  const clip = new File(['fixture'], 'clip.mov', { type: 'video/quicktime' });
  const result = readVideoDurationSeconds(clip);
  video.dispatchEvent(new Event('loadedmetadata'));
  expect(await result).toBe(2);
  expect(URL.createObjectURL).toHaveBeenCalledWith(clip);
});
it('settles a file the browser cannot read on its error and releases its blob URL', async () => {
  vi.mocked(video.canPlayType).mockReturnValue('');
  const result = readVideoDurationSeconds(new File(['fixture'], 'prores.mov', { type: 'video/quicktime' }));
  video.dispatchEvent(new Event('error'));
  expect(await result).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:probe');
  expect(vi.getTimerCount()).toBe(0);
});

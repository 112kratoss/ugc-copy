import { expect, it, vi } from 'vitest';
import { createPreviewPlaybackOwner, previewIntersectsViewport } from '../lib/native-preview-playback';
const viewport = { x: 0, y: 100, width: 400, height: 600 };
it('admits partly visible previews and rejects fully clipped or zero-sized previews', () => {
  expect(previewIntersectsViewport({ x: 10, y: 99, width: 300, height: 200 }, viewport)).toBe(true);
  expect(previewIntersectsViewport({ x: 10, y: -100, width: 300, height: 200 }, viewport)).toBe(false);
  expect(previewIntersectsViewport({ x: 10, y: 700, width: 300, height: 200 }, viewport)).toBe(false);
  expect(previewIntersectsViewport({ x: 400, y: 200, width: 300, height: 200 }, viewport)).toBe(false);
  expect(previewIntersectsViewport({ x: 10, y: 200, width: 0, height: 200 }, viewport)).toBe(false);
});
it('hands playback to the latest preview and ignores a late release from the previous one', () => {
  const ownership = createPreviewPlaybackOwner();
  const first = { pause: vi.fn() }, second = { pause: vi.fn() }, third = { pause: vi.fn() };
  ownership.claim(first); ownership.claim(first); expect(first.pause).not.toHaveBeenCalled();
  ownership.claim(second); expect(first.pause).toHaveBeenCalledOnce();
  ownership.release(first); ownership.claim(third); expect(second.pause).toHaveBeenCalledOnce();
  ownership.release(third); ownership.claim(first); expect(third.pause).not.toHaveBeenCalled();
});

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { toUsablePreviewSize } from '@/lib/preview-dimensions';
import { getStorageLocation } from '@/lib/storage-path';

describe('toUsablePreviewSize', () => {
  it('accepts a real pair', () => {
    expect(toUsablePreviewSize(720, 1280)).toEqual({ width: 720, height: 1280 });
  });

  it('refuses half a size, because a ratio needs both halves', () => {
    expect(toUsablePreviewSize(720, null)).toBeNull();
    expect(toUsablePreviewSize(null, 1280)).toBeNull();
    expect(toUsablePreviewSize(undefined, undefined)).toBeNull();
  });

  it('refuses a zero or a negative rather than passing on an impossible ratio', () => {
    // The grid divides a column width by this. A zero is not a flatter card.
    expect(toUsablePreviewSize(0, 512)).toBeNull();
    expect(toUsablePreviewSize(512, 0)).toBeNull();
    expect(toUsablePreviewSize(-720, 1280)).toBeNull();
  });

  it('refuses values that are not finite numbers', () => {
    expect(toUsablePreviewSize(Number.NaN, 100)).toBeNull();
    expect(toUsablePreviewSize(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it('rounds, because a pixel count is a whole number', () => {
    expect(toUsablePreviewSize(719.6, 1279.4)).toEqual({ width: 720, height: 1279 });
  });
});

describe('measuring a real stored preview', () => {
  it('reads back the dimensions a preview was encoded at', async () => {
    // The pipeline resizes `fit: inside` into webp; this is that shape, so the
    // ratio a card is laid out from is the ratio the source had.
    const preview = await sharp({
      create: { width: 900, height: 1600, channels: 3, background: '#101014' },
    })
      .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();

    const metadata = await sharp(preview).metadata();
    const size = toUsablePreviewSize(metadata.width, metadata.height);

    expect(size).toEqual({ width: 405, height: 720 });
    // Faithful on ratio, smaller in absolute terms — which is the whole reason
    // the columns are named for the preview and not for the source output.
    expect(size!.width / size!.height).toBeCloseTo(900 / 1600, 2);
  });
});

describe('getStorageLocation', () => {
  it('splits a stored path into bucket and object path', () => {
    expect(getStorageLocation('showcase_media/user-1/cover.preview.webp')).toEqual({
      bucket: 'showcase_media',
      filePath: 'user-1/cover.preview.webp',
    });
  });

  it('tolerates a leading slash', () => {
    expect(getStorageLocation('/showcase_media/user-1/cover.webp')?.bucket).toBe('showcase_media');
  });

  it('refuses anything that is not a bucket plus an object', () => {
    // Guessing a bucket would address the wrong one silently.
    expect(getStorageLocation('cover.webp')).toBeNull();
    expect(getStorageLocation('showcase_media/')).toBeNull();
    expect(getStorageLocation('/')).toBeNull();
  });
});

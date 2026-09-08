import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import {
  DISPLAY_MAX_SIZE,
  buildDisplayRenditionPath,
  encodeDisplayRendition,
} from '@/lib/media-display-rendition';

/**
 * The display rendition only earns its existence by being smaller than the
 * source. These pin that it is produced when it helps and refused when it
 * does not — a refusal is a normal answer, and every reader falls back to the
 * source for it.
 */
async function noisyImage(width: number, height: number) {
  // Genuinely incompressible pixels. A linear ramp would let PNG collapse the
  // source to a few KB, and then every size comparison below would be against
  // a number no real photo produces.
  const channels = 3 as const;
  const pixels = Buffer.alloc(width * height * channels);
  let state = 0x9e3779b9;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

describe('buildDisplayRenditionPath', () => {
  it('sits beside the preview under the same base name', () => {
    expect(buildDisplayRenditionPath('showcase/gen-1/photo.abc123.jpg', 'deadbeef'))
      .toBe('showcase/gen-1/photo.abc123.display.deadbeef.webp');
  });

  it('appends rather than corrupting a path with no extension', () => {
    expect(buildDisplayRenditionPath('posts/post-1/0/photo', 'deadbeef'))
      .toBe('posts/post-1/0/photo.display.deadbeef.webp');
    // A dot in a directory name is not an extension.
    expect(buildDisplayRenditionPath('posts/post.1/photo', 'deadbeef'))
      .toBe('posts/post.1/photo.display.deadbeef.webp');
  });
});

describe('encodeDisplayRendition', () => {
  it('shrinks a large source to the display size', async () => {
    const source = await noisyImage(3000, 2000);
    const image = sharp(source);

    const display = await encodeDisplayRendition({
      image,
      sourceBytes: source.byteLength,
      width: 3000,
      height: 2000,
    });

    expect(display).not.toBeNull();
    expect(display!.width).toBe(DISPLAY_MAX_SIZE);
    expect(display!.body.byteLength).toBeLessThan(source.byteLength);
    expect(display!.storagePathHash).toMatch(/^[0-9a-f]+$/);
  });

  it('refuses when the source is already small and modest, so no second copy is stored', async () => {
    const source = await noisyImage(600, 400);
    const display = await encodeDisplayRendition({
      image: sharp(source),
      sourceBytes: 120_000,
      width: 600,
      height: 400,
    });

    expect(display).toBeNull();
  });

  it('still re-encodes a heavy source that happens to be small in pixels', async () => {
    // A 4 MB PNG at 1200px is exactly the case a dimension-only rule misses.
    const source = await noisyImage(1200, 1200);
    const display = await encodeDisplayRendition({
      image: sharp(source),
      sourceBytes: 4_000_000,
      width: 1200,
      height: 1200,
    });

    expect(display).not.toBeNull();
    expect(display!.body.byteLength).toBeLessThan(4_000_000 * 0.75);
  });

  it('refuses when the encode would not beat the source by a worthwhile margin', async () => {
    const source = await noisyImage(2000, 2000);
    const image = sharp(source);
    // Claim the source is already tiny: whatever the encoder produces cannot
    // be 25% smaller than that, so there is nothing to gain.
    const display = await encodeDisplayRendition({
      image,
      sourceBytes: 1_000,
      width: 2000,
      height: 2000,
    });

    expect(display).toBeNull();
  });

  it('never enlarges a source between the preview and display sizes', async () => {
    const source = await noisyImage(1000, 1000);
    const display = await encodeDisplayRendition({
      image: sharp(source),
      sourceBytes: 2_000_000,
      width: 1000,
      height: 1000,
    });

    expect(display).not.toBeNull();
    expect(display!.width).toBe(1000);
    expect(display!.height).toBe(1000);
  });
});

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createGenerationImagePreview } from '@/lib/generation-media-preview';

describe('generation media previews', () => {
  it('creates an immutable image derivative with ThumbHash metadata', async () => {
    const input = await sharp({
      create: {
        width: 900,
        height: 1200,
        channels: 3,
        background: '#6d28d9',
      },
    }).jpeg().toBuffer();
    // The upload is read back and checked for integrity, so the double has to
    // return the bytes it was handed.
    let written: Blob | null = null;
    const upload = vi.fn(async (_path: string, body: Blob) => {
      written = body;
      return { error: null };
    });
    const download = vi.fn(async () => ({
      error: null,
      data: { arrayBuffer: async () => (written ?? new Blob([])).arrayBuffer() },
    }));
    const supabase = {
      storage: {
        from: vi.fn(() => ({ upload, download })),
      },
    };

    const result = await createGenerationImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    });

    expect(result).toMatchObject({
      previewStatus: 'ready',
      previewThumbhash: expect.any(String),
      // 900px on the long edge and a few KB: the source is already display-
      // sized, so no second copy is stored and readers fall back to it.
      displayStoragePath: null,
    });
    expect(result?.previewStoragePath).toMatch(
      /^generated_images\/user-1\/output\.preview\.[a-f0-9]{16}\.webp$/
    );
    // A Blob, never a Buffer: the storage client only routes Blobs through its
    // multipart path, and a Buffer falls through to a raw body that gets UTF-8
    // stringified in transit — which is what corrupted four stored previews.
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/output\.preview\.[a-f0-9]{16}\.webp$/),
      expect.any(Blob),
      expect.objectContaining({ cacheControl: '86400', upsert: true })
    );
  });

  it('stores a 1440px display rendition beside the preview when the source is large', async () => {
    // Incompressible pixels, so the size comparison inside encodeDisplayRendition
    // is against a number a real photo produces rather than a flat-colour JPEG.
    const width = 2400;
    const height = 3200;
    const channels = 3 as const;
    const pixels = Buffer.alloc(width * height * channels);
    let state = 0x9e3779b9;
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      pixels[index] = state & 0xff;
    }
    const input = await sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();

    let written: Blob | null = null;
    const upload = vi.fn(async (_path: string, body: Blob) => {
      written = body;
      return { error: null };
    });
    const download = vi.fn(async () => ({
      error: null,
      data: { arrayBuffer: async () => (written ?? new Blob([])).arrayBuffer() },
    }));
    const from = vi.fn((_bucket: string) => ({ upload, download }));

    const result = await createGenerationImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/png' }),
      storagePath: 'generated_images/user-1/output.png',
      supabase: { storage: { from } } as never,
    });

    expect(result?.displayStoragePath).toMatch(
      /^generated_images\/user-1\/output\.display\.[a-f0-9]{16}\.webp$/
    );
    // Same private bucket as the preview, never the public showcase bucket.
    expect(from.mock.calls.every(([bucket]) => bucket === 'generated_images')).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenLastCalledWith(
      expect.stringMatching(/^user-1\/output\.display\.[a-f0-9]{16}\.webp$/),
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/webp', upsert: true })
    );
    const display = await sharp(Buffer.from(await (written as unknown as Blob).arrayBuffer())).metadata();
    expect(Math.max(display.width ?? 0, display.height ?? 0)).toBe(1440);
  });
});

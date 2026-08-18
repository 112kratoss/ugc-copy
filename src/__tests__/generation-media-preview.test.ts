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
    let written: Buffer | null = null;
    const upload = vi.fn(async (_path: string, body: Buffer) => {
      written = body;
      return { error: null };
    });
    const download = vi.fn(async () => ({
      error: null,
      data: { arrayBuffer: async () => Uint8Array.from(written ?? Buffer.alloc(0)).buffer },
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
    });
    expect(result?.previewStoragePath).toMatch(
      /^generated_images\/user-1\/output\.preview\.[a-f0-9]{16}\.webp$/
    );
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^user-1\/output\.preview\.[a-f0-9]{16}\.webp$/),
      expect.any(Buffer),
      expect.objectContaining({ cacheControl: '86400', upsert: true })
    );
  });
});

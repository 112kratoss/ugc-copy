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
    const upload = vi.fn(async () => ({ error: null }));
    const supabase = {
      storage: {
        from: vi.fn(() => ({ upload })),
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

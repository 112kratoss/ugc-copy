import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createPostMediaImagePreview } from '@/lib/post-media-preview';

describe('post preview storage integrity', () => {
  it('does not report ready when storage accepts an upload but returns changed bytes', async () => {
    const input = await sharp({ create: { width: 60, height: 80, channels: 3, background: '#123456' } })
      .jpeg().toBuffer();
    let uploaded: Blob | undefined;
    const upload = vi.fn(async (_path: string, body: Blob) => {
      uploaded = body;
      return { error: null };
    });
    const download = vi.fn(async () => {
      const bytes = Buffer.from(await uploaded!.arrayBuffer());
      // Keep the RIFF signature and exact length, corrupt the compressed body.
      bytes.fill(0, 12);
      return { error: null, data: new Blob([Uint8Array.from(bytes)]) };
    });
    const supabase = { storage: { from: () => ({ upload, download }) } };

    await expect(createPostMediaImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      storagePath: 'posts/post-1/0/input.jpg',
      contentType: 'image/jpeg',
      supabase: supabase as never,
    })).rejects.toThrow(/does not match the encoded preview/);
  });
});

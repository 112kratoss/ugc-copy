import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const videoPosterState = vi.hoisted(() => ({
  createVideoPosterBuffer: vi.fn(async () => Buffer.from('poster-webp')),
}));

vi.mock('@/lib/generation-media-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-media-preview')>();
  return {
    ...actual,
    createVideoPosterBuffer: videoPosterState.createVideoPosterBuffer,
  };
});

import {
  buildPostMediaPreviewPath,
  createPostMediaImagePreview,
  createPostMediaPreview,
} from '@/lib/post-media-preview';

describe('post media image previews', () => {
  beforeEach(() => {
    videoPosterState.createVideoPosterBuffer.mockClear();
  });

  it('uses a deterministic sibling WebP path', () => {
    expect(buildPostMediaPreviewPath('posts/post-1/0/portrait.png')).toBe(
      'posts/post-1/0/portrait.preview.webp'
    );
  });

  it('creates a bounded WebP preview and returns source dimensions', async () => {
    const input = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: '#7c3aed',
      },
    }).jpeg().toBuffer();
    const upload = vi.fn(async (path: string, body: Buffer, options: Record<string, unknown>) => {
      void path;
      void body;
      void options;
      return { error: null };
    });
    const supabase = {
      storage: {
        from: () => ({ upload }),
      },
    };

    const result = await createPostMediaImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      storagePath: 'posts/post-1/0/portrait.jpg',
      supabase: supabase as never,
    });

    expect(result).toEqual({
      previewStoragePath: 'posts/post-1/0/portrait.preview.webp',
      width: 1200,
      height: 800,
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe('posts/post-1/0/portrait.preview.webp');
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });
  });

  it('skips video inputs without uploading', async () => {
    const upload = vi.fn();
    const supabase = {
      storage: {
        from: () => ({ upload }),
      },
    };

    const result = await createPostMediaImagePreview({
      body: new Blob(['video'], { type: 'video/mp4' }),
      contentType: 'video/mp4',
      storagePath: 'posts/post-1/0/video.mp4',
      supabase: supabase as never,
    });

    expect(result).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('creates a video poster preview for post media videos', async () => {
    const upload = vi.fn(async (path: string, body: Buffer, options: Record<string, unknown>) => {
      void path;
      void body;
      void options;
      return { error: null };
    });
    const supabase = {
      storage: {
        from: () => ({ upload }),
      },
    };
    const body = new Blob([Uint8Array.from([1, 2, 3])], { type: 'video/mp4' });

    const result = await createPostMediaPreview({
      body,
      contentType: 'video/mp4',
      storagePath: 'posts/post-1/0/video.mp4',
      supabase: supabase as never,
    });

    expect(result).toEqual({
      previewStoragePath: 'posts/post-1/0/video.preview.webp',
      width: null,
      height: null,
    });
    expect(videoPosterState.createVideoPosterBuffer).toHaveBeenCalledWith(body);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe('posts/post-1/0/video.preview.webp');
    expect(upload.mock.calls[0]?.[1]).toEqual(Buffer.from('poster-webp'));
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: true,
    });
  });
});

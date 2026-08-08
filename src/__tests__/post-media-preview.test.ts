import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const videoPosterState = vi.hoisted(() => ({
  createVideoPosterBuffer: vi.fn(async () => Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )),
}));

vi.mock('@/lib/video-poster', () => {
  return {
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
    expect(buildPostMediaPreviewPath('posts/post-1/0/portrait.png', 'abc123')).toBe(
      'posts/post-1/0/portrait.preview.abc123.webp'
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

    expect(result).toMatchObject({
      width: 1200,
      height: 800,
      previewStatus: 'ready',
    });
    expect(result?.previewStoragePath).toMatch(/^posts\/post-1\/0\/portrait\.preview\.[a-f0-9]{16}\.webp$/);
    expect(result?.previewThumbhash).toEqual(expect.any(String));
    expect(result?.previewThumbhash.length).toBeGreaterThan(8);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(result?.previewStoragePath);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      cacheControl: '86400',
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

    expect(result).toMatchObject({
      width: null,
      height: null,
      previewStatus: 'ready',
    });
    expect(result?.previewStoragePath).toMatch(/^posts\/post-1\/0\/video\.preview\.[a-f0-9]{16}\.webp$/);
    expect(result?.previewThumbhash).toEqual(expect.any(String));
    expect(videoPosterState.createVideoPosterBuffer).toHaveBeenCalledWith(body);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(result?.previewStoragePath);
    expect(upload.mock.calls[0]?.[1]).toEqual(await videoPosterState.createVideoPosterBuffer.mock.results[0]?.value);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      cacheControl: '86400',
      contentType: 'image/webp',
      upsert: true,
    });
  });
});

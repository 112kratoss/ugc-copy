import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const videoPosterState = vi.hoisted(() => ({
  createVideoPosterBuffer: vi.fn<() => Promise<Buffer>>(),
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
  beforeEach(async () => {
    videoPosterState.createVideoPosterBuffer.mockReset();
    videoPosterState.createVideoPosterBuffer.mockResolvedValue(await sharp({
      create: { width: 60, height: 80, channels: 3, background: '#123456' },
    }).webp().toBuffer());
  });

  it('tells the caller every object it writes', async () => {
    // Wide enough that the display rendition earns its own object.
    const input = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#7c3aed' } }).jpeg().toBuffer();
    const stored = new Map<string, Blob>();
    const upload = vi.fn(async (path: string, body: Blob) => {
      stored.set(path, body);
      return { error: null };
    });
    const supabase = {
      storage: { from: () => ({ upload, download: async (path: string) => ({ error: null, data: stored.get(path) }) }) },
    };
    const reported: string[] = [];

    const result = await createPostMediaImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      storagePath: 'showcase/gen-1/wide.jpg',
      supabase: supabase as never,
      onUploaded: (path) => { reported.push(path); },
    });

    expect(result?.displayStoragePath).toEqual(expect.any(String));
    expect(reported).toEqual([result?.previewStoragePath, result?.displayStoragePath]);
  });

  it('has told the caller of an upload whose stored copy then fails its check', async () => {
    const input = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7c3aed' } }).jpeg().toBuffer();
    const supabase = {
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          download: async () => ({ error: null, data: new Blob(['mangled in transit']) }),
        }),
      },
    };
    const reported: string[] = [];

    await expect(createPostMediaImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      storagePath: 'showcase/gen-1/photo.jpg',
      supabase: supabase as never,
      onUploaded: (path) => { reported.push(path); },
    })).rejects.toThrow();

    expect(reported).toEqual([expect.stringMatching(/^showcase\/gen-1\/photo\.preview\.[a-f0-9]{16}\.webp$/)]);
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
    const upload = vi.fn(async (path: string, body: Blob, options: Record<string, unknown>) => {
      void path;
      void body;
      void options;
      return { error: null };
    });
    const supabase = {
      storage: {
        from: () => ({ upload, download: async () => ({ error: null, data: upload.mock.calls[0]?.[1] }) }),
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

  it('records a phone photo at the size it is drawn, with its EXIF rotation applied', async () => {
    // Stored 1200x800 with orientation 6: every viewer draws it 800x1200.
    const input = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: '#7c3aed',
      },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    // Control: the stored header itself still says landscape.
    expect(await sharp(input).metadata()).toMatchObject({ width: 1200, height: 800, orientation: 6 });
    const upload = vi.fn(async (path: string, body: Blob, options: Record<string, unknown>) => {
      void path;
      void body;
      void options;
      return { error: null };
    });
    const supabase = {
      storage: {
        from: () => ({ upload, download: async () => ({ error: null, data: upload.mock.calls[0]?.[1] }) }),
      },
    };

    const result = await createPostMediaImagePreview({
      body: new Blob([Uint8Array.from(input)], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      storagePath: 'posts/post-1/0/phone.jpg',
      supabase: supabase as never,
    });

    expect(result).toMatchObject({ width: 800, height: 1200 });
    // The stored preview is portrait as well, so the card and its picture agree.
    const previewBody = upload.mock.calls[0]?.[1];
    expect(previewBody).toBeInstanceOf(Blob);
    const previewBytes = Buffer.from(await previewBody!.arrayBuffer());
    expect(await sharp(previewBytes).metadata()).toMatchObject({ width: 480, height: 720 });
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
    const upload = vi.fn(async (path: string, body: Blob, options: Record<string, unknown>) => {
      void path;
      void body;
      void options;
      return { error: null };
    });
    const supabase = {
      storage: {
        from: () => ({ upload, download: async () => ({ error: null, data: upload.mock.calls[0]?.[1] }) }),
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
    // Uploaded as a Blob carrying the poster's bytes, not as the Buffer itself:
    // the storage client only sends Blobs down its multipart path, and a Buffer
    // falls through to a raw body that gets UTF-8 stringified in transit.
    const posterBytes: Buffer = await videoPosterState.createVideoPosterBuffer.mock.results[0]?.value;
    const uploadedBody = upload.mock.calls[0]?.[1] as unknown as Blob;
    expect(uploadedBody).toBeInstanceOf(Blob);
    expect(Buffer.from(await uploadedBody.arrayBuffer())).toEqual(posterBytes);
    expect(upload.mock.calls[0]?.[2]).toMatchObject({
      cacheControl: '86400',
      contentType: 'image/webp',
      upsert: true,
    });
  });
});

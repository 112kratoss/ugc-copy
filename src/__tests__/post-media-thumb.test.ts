import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const loggerState = vi.hoisted(() => ({ logBackendWarning: vi.fn() }));
vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  logBackendWarning: loggerState.logBackendWarning,
}));

const videoPosterState = vi.hoisted(() => ({
  createVideoPosterBuffer: vi.fn<() => Promise<Buffer>>(),
}));
vi.mock('@/lib/video-poster', () => ({
  createVideoPosterBuffer: videoPosterState.createVideoPosterBuffer,
}));

import {
  buildPostMediaPreviewPath,
  buildPostMediaThumbPath,
  canStorePostMediaThumb,
  createPostMediaPreview,
  encodePostMediaThumb,
  POST_MEDIA_THUMB_SHORT_SIDE,
  storePostMediaThumb,
} from '@/lib/post-media-preview';

/** Storage that keeps what is uploaded, by bucket, and reads it back. */
function fakeStorage({ failUploadOf }: { failUploadOf?: RegExp } = {}) {
  const stored = new Map<string, Blob>();
  const uploads: Array<{ bucket: string; path: string; body: Blob; options: Record<string, unknown> }> = [];
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Blob, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, body, options });
          if (failUploadOf?.test(path)) return { error: { message: 'storage unavailable' } };
          stored.set(`${bucket}/${path}`, body);
          return { error: null };
        },
        download: async (path: string) => ({ error: null, data: stored.get(`${bucket}/${path}`) }),
      }),
    },
  };
  return { supabase: supabase as never, uploads, stored };
}

async function webp(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#7c3aed' } }).webp({ quality: 72 }).toBuffer();
}

async function jpegBlob(width: number, height: number): Promise<Blob> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#0ea5e9' } }).jpeg().toBuffer();
  return new Blob([Uint8Array.from(bytes)], { type: 'image/jpeg' });
}

describe('a post media row thumb', () => {
  beforeEach(() => {
    loggerState.logBackendWarning.mockReset();
    videoPosterState.createVideoPosterBuffer.mockReset();
  });

  it('is 144 px on its short side, keeps the picture’s shape, and is a WebP', async () => {
    // The web's largest search row frame is 48 px, at 3x.
    expect(POST_MEDIA_THUMB_SHORT_SIDE).toBe(144);
    const portrait = await sharp(await encodePostMediaThumb(await webp(540, 720))).metadata();
    expect([portrait.format, portrait.width, portrait.height]).toEqual(['webp', 144, 192]);
    const landscape = await sharp(await encodePostMediaThumb(await webp(720, 405))).metadata();
    expect([landscape.width, landscape.height]).toEqual([256, 144]);
  });

  it('is never larger than the preview it is made from', async () => {
    const small = await sharp(await encodePostMediaThumb(await webp(100, 120))).metadata();
    expect([small.width, small.height]).toEqual([100, 120]);
  });

  it('is a fraction of the preview’s bytes', async () => {
    // A picture with detail, as a cover has: a flat colour compresses to nothing either way.
    const noise = Buffer.from(Array.from({ length: 540 * 720 * 3 }, (_, index) => (index * 2654435761) % 251));
    const preview = await sharp(noise, { raw: { width: 540, height: 720, channels: 3 } }).webp({ quality: 72 }).toBuffer();
    const thumb = await encodePostMediaThumb(preview);
    expect(thumb.byteLength).toBeLessThan(preview.byteLength / 5);
  });

  it('is named beside its source and its preview, content-addressed', () => {
    expect(buildPostMediaThumbPath('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.png', '0123456789abcdef'))
      .toBe('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.thumb.0123456789abcdef.webp');
    expect(buildPostMediaPreviewPath('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.png', '0123456789abcdef'))
      .toBe('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.preview.0123456789abcdef.webp');
    expect(buildPostMediaThumbPath('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/no-extension', 'ff')).toBe('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/no-extension.thumb.ff.webp');
  });

  it('is stored in the public bucket as a WebP Blob, and told to the caller before its check', async () => {
    const { supabase, uploads } = fakeStorage();
    const reported: string[] = [];
    const preview = await webp(540, 720);

    const thumb = await storePostMediaThumb({
      supabase,
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.png',
      preview,
      onUploaded: (path) => { reported.push(path); },
    });

    expect(thumb?.path).toMatch(/^showcase\/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e\/output\.abc123\.thumb\.[a-f0-9]{16}\.webp$/);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe('showcase_media');
    // A Blob, never a Buffer: supabase-js stringifies a Buffer.
    expect(uploads[0].body).toBeInstanceOf(Blob);
    expect(uploads[0].body.type).toBe('image/webp');
    expect(uploads[0].options).toMatchObject({ contentType: 'image/webp', upsert: true });
    expect(thumb?.bytes).toBe(uploads[0].body.size);
    expect(reported).toEqual([thumb?.path]);
  });

  it('is made only in a creation\u2019s public folder, the one every cleanup reaches (review of #906)', async () => {
    expect(canStorePostMediaThumb('showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.png')).toBe(true);
    for (const outside of [
      'posts/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/0/photo.jpg',
      'private-posts/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/0/photo.jpg',
      'showcase/seed-1.png',
      'showcase/not-a-creation/output.png',
      'showcase/7D3E2B1A-0C4F-4A5B-9E6D-1F2A3B4C5D6E/output.png',
      'seed/1/source.png',
    ]) {
      expect(canStorePostMediaThumb(outside), outside).toBe(false);
      const { supabase, uploads } = fakeStorage();
      expect(await storePostMediaThumb({ supabase, storagePath: outside, preview: await webp(540, 720) }), outside).toBeNull();
      expect(uploads, outside).toEqual([]);
    }
  });

  it('is never made for a source in the private bucket', async () => {
    const { supabase, uploads } = fakeStorage();
    const thumb = await storePostMediaThumb({
      supabase,
      storagePath: 'private-posts/post-1/0/photo.jpg',
      preview: await webp(540, 720),
    });
    expect(thumb).toBeNull();
    expect(uploads).toEqual([]);
  });

  it('throws when its upload fails, having told the caller of it', async () => {
    const { supabase } = fakeStorage({ failUploadOf: /\.thumb\./ });
    const reported: string[] = [];
    await expect(storePostMediaThumb({
      supabase,
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.png',
      preview: await webp(540, 720),
      onUploaded: (path) => { reported.push(path); },
    })).rejects.toMatchObject({ message: 'storage unavailable' });
    expect(reported).toEqual([expect.stringMatching(/\.thumb\.[a-f0-9]{16}\.webp$/)]);
  });
});

describe('a preview with its row thumb', () => {
  beforeEach(() => {
    loggerState.logBackendWarning.mockReset();
    videoPosterState.createVideoPosterBuffer.mockReset();
  });

  it('comes with a thumb made from the stored preview when the caller asks for one', async () => {
    const { supabase, stored } = fakeStorage();
    const reported: string[] = [];

    const result = await createPostMediaPreview({
      body: await jpegBlob(1200, 1600),
      contentType: 'image/jpeg',
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.jpg',
      supabase,
      onUploaded: (path) => { reported.push(path); },
      withThumb: true,
    });

    expect(result?.thumbStoragePath).toMatch(/^showcase\/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e\/output\.abc123\.thumb\.[a-f0-9]{16}\.webp$/);
    expect(reported).toContain(result?.thumbStoragePath);
    const preview = stored.get(`showcase_media/${result?.previewStoragePath}`);
    const thumb = stored.get(`showcase_media/${result?.thumbStoragePath}`);
    const expected = await encodePostMediaThumb(Buffer.from(await preview!.arrayBuffer()));
    expect(Buffer.from(await thumb!.arrayBuffer()).equals(expected)).toBe(true);
  });

  it('comes without one unless asked: the publish and edit services record none', async () => {
    const { supabase, uploads } = fakeStorage();
    const result = await createPostMediaPreview({
      body: await jpegBlob(1200, 1600),
      contentType: 'image/jpeg',
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.jpg',
      supabase,
    });
    expect(result?.thumbStoragePath).toBeNull();
    expect(uploads.some((upload) => upload.path.includes('.thumb.'))).toBe(false);
  });

  it('comes without one for a private source', async () => {
    const { supabase, uploads } = fakeStorage();
    const result = await createPostMediaPreview({
      body: await jpegBlob(1200, 1600),
      contentType: 'image/jpeg',
      storagePath: 'private-posts/post-1/0/photo.jpg',
      supabase,
      withThumb: true,
    });
    expect(result?.previewStoragePath).toMatch(/^private-posts\//);
    expect(result?.thumbStoragePath).toBeNull();
    expect(uploads.some((upload) => upload.path.includes('.thumb.'))).toBe(false);
  });

  it('is still made when its thumb cannot be: the row draws the preview, and the failure is logged', async () => {
    const { supabase } = fakeStorage({ failUploadOf: /\.thumb\./ });
    const reported: string[] = [];

    const result = await createPostMediaPreview({
      body: await jpegBlob(1200, 1600),
      contentType: 'image/jpeg',
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.jpg',
      supabase,
      onUploaded: (path) => { reported.push(path); },
      withThumb: true,
    });

    expect(result?.previewStatus).toBe('ready');
    expect(result?.thumbStoragePath).toBeNull();
    // Told, so the caller queues it: a write whose reply was lost may have landed.
    expect(reported.some((path) => path.includes('.thumb.'))).toBe(true);
    expect(loggerState.logBackendWarning).toHaveBeenCalledWith('post_media_thumb_not_stored', expect.objectContaining({
      storagePath: 'showcase/7d3e2b1a-0c4f-4a5b-9e6d-1f2a3b4c5d6e/output.abc123.jpg',
    }));
  });

  it('of a video is its poster’s thumb', async () => {
    videoPosterState.createVideoPosterBuffer.mockResolvedValue(await webp(405, 720));
    const { supabase, stored } = fakeStorage();

    const result = await createPostMediaPreview({
      body: new Blob([Uint8Array.from([0, 0, 0, 24])], { type: 'video/mp4' }),
      contentType: 'video/mp4',
      storagePath: 'showcase/0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e/clip.def456.mp4',
      supabase,
      withThumb: true,
    });

    expect(result?.thumbStoragePath).toMatch(/^showcase\/0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e\/clip\.def456\.thumb\.[a-f0-9]{16}\.webp$/);
    const thumb = await sharp(Buffer.from(await stored.get(`showcase_media/${result?.thumbStoragePath}`)!.arrayBuffer())).metadata();
    expect([thumb.width, thumb.height]).toEqual([144, 256]);
  });
});

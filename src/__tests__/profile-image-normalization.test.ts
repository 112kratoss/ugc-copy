import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  PROFILE_IMAGE_MAX_EDGE,
  getProfileCoverFrame,
  getProfileImageRole,
  normalizeStoredProfileImage,
} from '@/lib/profile-image-normalization';

async function image(width: number, height: number) {
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

// Red above and below, green through the middle 30%: a centre cut to 40:9
// keeps only green, a top or bottom cut would keep red.
async function bandedSquare(size: number) {
  const channels = 3 as const;
  const pixels = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y += 1) {
    const green = y >= size * 0.35 && y < size * 0.65;
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * channels;
      pixels[offset] = green ? 0 : 255;
      pixels[offset + 1] = green ? 255 : 0;
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels } }).png().toBuffer();
}

async function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } }).png().toBuffer();
}

async function uploadedImage(upload: ReturnType<typeof vi.fn>) {
  const [, body] = upload.mock.calls[0] as unknown as [string, Blob];
  return Buffer.from(await body.arrayBuffer());
}

function createClient(body: Buffer | null) {
  const upload = vi.fn(async () => ({ error: null }));
  const download = vi.fn(async () => ({
    data: body ? new Blob([new Uint8Array(body)], { type: 'image/png' }) : null,
    error: body ? null : new Error('missing'),
  }));
  return {
    upload,
    download,
    client: { storage: { from: () => ({ download, upload }) } } as never,
  };
}

describe('getProfileImageRole', () => {
  it('reads the role the signing route mints into the object name', () => {
    expect(getProfileImageRole('user-1/avatar-abc-photo.png')).toBe('avatar');
    expect(getProfileImageRole('user-1/cover-abc-photo.png')).toBe('cover');
  });

  it('refuses to guess at anything else', () => {
    expect(getProfileImageRole('user-1/photo.png')).toBeNull();
    // Not a role prefix on the object name, whatever the directory says.
    expect(getProfileImageRole('avatar-user/photo.png')).toBeNull();
  });
});

describe('normalizeStoredProfileImage', () => {
  it('resizes an oversized avatar in place, so its URL stays correct', async () => {
    const source = await image(2048, 2048);
    const { client, upload } = createClient(source);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.png',
    })).resolves.toBe(true);

    expect(upload).toHaveBeenCalledTimes(1);
    const [uploadedPath, , options] = upload.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    // The same path: no column to rewrite and no orphaned copy left public.
    expect(uploadedPath).toBe('user-1/avatar-abc-photo.png');
    expect(options).toMatchObject({ upsert: true, contentType: 'image/webp' });
  });

  it('gives a cover more room than an avatar', () => {
    expect(PROFILE_IMAGE_MAX_EDGE.avatar).toBeLessThan(PROFILE_IMAGE_MAX_EDGE.cover);
  });

  it('leaves an image that is already small enough alone', async () => {
    const source = await image(256, 256);
    const { client, upload } = createClient(source);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.png',
    })).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('never replaces an image with a larger one', async () => {
    // A small, already well-compressed avatar must keep its own bytes.
    const source = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#336699' },
    }).webp({ quality: 60 }).toBuffer();
    const { client, upload } = createClient(source);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.webp',
    })).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports a failure rather than throwing into the profile save', async () => {
    const { client, upload } = createClient(null);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.png',
    })).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('cuts a square cover to the 40:9 frame at 1600×360, from its centre', async () => {
    const { client, upload } = createClient(await bandedSquare(2000));

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/cover-abc-photo.png',
    })).resolves.toBe(true);

    expect(upload).toHaveBeenCalledTimes(1);
    const [uploadedPath] = upload.mock.calls[0] as unknown as [string];
    expect(uploadedPath).toBe('user-1/cover-abc-photo.png');
    const output = await uploadedImage(upload);
    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect({ width: info.width, height: info.height }).toEqual({ width: 1600, height: 360 });
    for (const [x, y] of [[0, 0], [1599, 0], [800, 180], [0, 359], [1599, 359]]) {
      const offset = (y * info.width + x) * info.channels;
      expect({ x, y, red: data[offset] < 60, green: data[offset + 1] > 200 })
        .toEqual({ x, y, red: true, green: true });
    }
  });

  it('frames a small cover at 40:9 without enlarging it, whatever the bytes', async () => {
    const source = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#336699' },
    }).webp({ quality: 60 }).toBuffer();
    const { client, upload } = createClient(source);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/cover-abc-photo.webp',
    })).resolves.toBe(true);

    const metadata = await sharp(await uploadedImage(upload)).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 400, height: 90 });
  });

  it('leaves a cover already at its 40:9 frame alone', async () => {
    for (const [width, height] of [[1600, 360], [800, 180]]) {
      const { client, upload } = createClient(await solid(width, height));

      await expect(normalizeStoredProfileImage({
        adminSupabase: client,
        bucket: 'profiles',
        filePath: 'user-1/cover-abc-photo.png',
      })).resolves.toBe(false);
      expect(upload).not.toHaveBeenCalled();
    }
  });

  it('reads a quarter-turned photo upright before framing it', async () => {
    // Stored 360×1600 with EXIF orientation 6: upright, it is already 1600×360.
    const source = await sharp({
      create: { width: 360, height: 1600, channels: 3, background: '#336699' },
    }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { client, upload } = createClient(source);

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/cover-abc-photo.jpg',
    })).resolves.toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps an avatar in its own shape', async () => {
    const { client, upload } = createClient(await image(2048, 1024));

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.png',
    })).resolves.toBe(true);

    const metadata = await sharp(await uploadedImage(upload)).metadata();
    expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 512, height: 256 });
  });

  it('ignores an object whose name carries no role', async () => {
    const { client, download } = createClient(await image(2048, 2048));

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/something-else.png',
    })).resolves.toBe(false);
    // Refused before spending a download.
    expect(download).not.toHaveBeenCalled();
  });
});

describe('getProfileCoverFrame', () => {
  it('is 1600×360, or the largest 40:9 rectangle a smaller picture holds', () => {
    expect(getProfileCoverFrame(2000, 2000)).toEqual({ width: 1600, height: 360 });
    expect(getProfileCoverFrame(1600, 360)).toEqual({ width: 1600, height: 360 });
    expect(getProfileCoverFrame(8000, 500)).toEqual({ width: 1600, height: 360 });
    expect(getProfileCoverFrame(800, 600)).toEqual({ width: 800, height: 180 });
    expect(getProfileCoverFrame(1000, 200)).toEqual({ width: 888, height: 200 });
    expect(getProfileCoverFrame(10, 10)).toEqual({ width: 10, height: 2 });
  });
});

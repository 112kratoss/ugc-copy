import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  PROFILE_IMAGE_MAX_EDGE,
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

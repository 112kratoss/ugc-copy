import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import {
  PROFILE_IMAGE_MAX_EDGE,
  buildNormalizedProfileImagePath,
  buildProfileImagePublicUrl,
  deriveNormalizedProfileImage,
  getProfileCoverFrame,
  getProfileImageRole,
  isNormalizedProfileImagePath,
  normalizeStoredProfileImage,
} from '@/lib/profile-image-normalization';
import { getUserOwnedStoredMediaLocation } from '@/lib/storage-ownership';

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

const PUBLIC_PROFILES = 'https://project.supabase.co/storage/v1/object/public/profiles/';

// Storage as the service role sees it: what is written can be read back, and
// an upload that fails leaves nothing behind.
function createStorage(objects: Record<string, Buffer>, options: {
  uploadError?: { message: string } | null;
  damageWrites?: boolean;
} = {}) {
  const store = new Map(Object.entries(objects));
  const download = vi.fn(async (path: string) => {
    const body = store.get(path);
    return body
      ? { data: new Blob([new Uint8Array(body)]), error: null }
      : { data: null, error: { message: 'Object not found', statusCode: '404' } };
  });
  const upload = vi.fn(async (path: string, body: Blob) => {
    if (options.uploadError) return { data: null, error: options.uploadError };
    const bytes = Buffer.from(await body.arrayBuffer());
    store.set(path, options.damageWrites ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
    return { data: { path }, error: null };
  });
  return {
    store,
    download,
    upload,
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

  it('never rewrites a normalised copy, whose name is its content', async () => {
    const { client, download } = createClient(await image(2048, 2048));

    await expect(normalizeStoredProfileImage({
      adminSupabase: client,
      bucket: 'profiles',
      filePath: 'user-1/avatar-abc-photo.normalized.0123456789abcdef.webp',
    })).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('deriveNormalizedProfileImage', () => {
  const avatarPath = 'user-1/avatar-abc-photo.png';
  const coverPath = 'user-1/cover-abc-photo.png';

  it('writes the normalised avatar beside the upload and never touches the upload', async () => {
    const source = await image(1024, 1024);
    const storage = createStorage({ [avatarPath]: source });

    const derived = await deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: PUBLIC_PROFILES + avatarPath,
    });

    expect(derived?.filePath).toMatch(/^user-1\/avatar-abc-photo\.normalized\.[0-9a-f]{16}\.webp$/);
    expect(derived?.url).toBe(PUBLIC_PROFILES + derived?.filePath);
    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [uploadedPath, , options] = storage.upload.mock.calls[0] as unknown as [string, Blob, Record<string, unknown>];
    // Storage refuses any write to a finalized upload's path; a fresh one is not refused.
    expect(uploadedPath).toBe(derived?.filePath);
    expect(options).toMatchObject({ upsert: true, contentType: 'image/webp' });
    expect(storage.store.get(avatarPath)?.equals(source)).toBe(true);
    const metadata = await sharp(storage.store.get(derived!.filePath)!).metadata();
    expect({ format: metadata.format, width: metadata.width, height: metadata.height })
      .toEqual({ format: 'webp', width: 512, height: 512 });
    // Read back before the profile is pointed at it.
    expect(storage.download).toHaveBeenLastCalledWith(derived?.filePath);
  });

  it('cuts a square cover to the 40:9 frame in its copy', async () => {
    const storage = createStorage({ [coverPath]: await bandedSquare(2000) });

    const derived = await deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: coverPath,
      sourceUrl: PUBLIC_PROFILES + coverPath,
    });

    expect(derived?.filePath).toMatch(/^user-1\/cover-abc-photo\.normalized\.[0-9a-f]{16}\.webp$/);
    const { data, info } = await sharp(storage.store.get(derived!.filePath)!).raw().toBuffer({ resolveWithObject: true });
    expect({ width: info.width, height: info.height }).toEqual({ width: 1600, height: 360 });
    for (const [x, y] of [[0, 0], [1599, 359], [800, 180]]) {
      const offset = (y * info.width + x) * info.channels;
      expect({ x, y, red: data[offset] < 60, green: data[offset + 1] > 200 })
        .toEqual({ x, y, red: true, green: true });
    }
  });

  it('names the copy by its content, so saving the same upload again writes the same copy', async () => {
    const storage = createStorage({ [avatarPath]: await solid(1024, 1024) });
    const input = { adminSupabase: storage.client, filePath: avatarPath, sourceUrl: PUBLIC_PROFILES + avatarPath };

    const first = await deriveNormalizedProfileImage(input);
    const second = await deriveNormalizedProfileImage(input);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(new Set(storage.upload.mock.calls.map(([path]) => path))).toEqual(new Set([first?.filePath]));
  });

  it('keeps the URL the client sent on its own origin, without its query', async () => {
    const storage = createStorage({ [avatarPath]: await solid(1024, 1024) });

    const derived = await deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: `https://media.magicbooklet.com/storage/v1/object/public/profiles/${avatarPath}?v=2`,
    });

    expect(derived?.url).toBe(`https://media.magicbooklet.com/storage/v1/object/public/profiles/${derived?.filePath}`);
  });

  it('leaves an image that is already right alone', async () => {
    const storage = createStorage({ [avatarPath]: await image(256, 256) });

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: PUBLIC_PROFILES + avatarPath,
    })).resolves.toBeNull();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('does not copy a normalised copy, and spends no download finding that out', async () => {
    const copyPath = 'user-1/avatar-abc-photo.normalized.0123456789abcdef.webp';
    const storage = createStorage({ [copyPath]: await image(1024, 1024) });

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: copyPath,
      sourceUrl: PUBLIC_PROFILES + copyPath,
    })).resolves.toBeNull();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('makes no copy it could not name a public URL for', async () => {
    const storage = createStorage({ [avatarPath]: await image(1024, 1024) });

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: `https://project.supabase.co/storage/v1/object/sign/profiles/${avatarPath}?token=t`,
    })).resolves.toBeNull();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('keeps the upload when the copy cannot be written', async () => {
    const storage = createStorage(
      { [avatarPath]: await image(1024, 1024) },
      { uploadError: { message: 'Upload owner has been permanently blocked' } },
    );

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: PUBLIC_PROFILES + avatarPath,
    })).resolves.toBeNull();
  });

  it('keeps the upload when the copy reads back damaged', async () => {
    const storage = createStorage({ [avatarPath]: await solid(1024, 1024) }, { damageWrites: true });

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: PUBLIC_PROFILES + avatarPath,
    })).resolves.toBeNull();
  });

  it('keeps the upload when the upload cannot be read', async () => {
    const storage = createStorage({});

    await expect(deriveNormalizedProfileImage({
      adminSupabase: storage.client,
      filePath: avatarPath,
      sourceUrl: PUBLIC_PROFILES + avatarPath,
    })).resolves.toBeNull();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('normalised copy names and URLs', () => {
  it('sits beside its upload under the same owner', () => {
    expect(buildNormalizedProfileImagePath('user-1/avatar-abc-photo.png', '0123456789abcdef'))
      .toBe('user-1/avatar-abc-photo.normalized.0123456789abcdef.webp');
    expect(buildNormalizedProfileImagePath('user-1/avatar-abc', '0123456789abcdef'))
      .toBe('user-1/avatar-abc.normalized.0123456789abcdef.webp');
  });

  it('is never a name the signing route can mint, whose names carry one dot', () => {
    expect(isNormalizedProfileImagePath('user-1/avatar-abc-photo.normalized.0123456789abcdef.webp')).toBe(true);
    // What `photo.normalized.webp` becomes when the signing route sanitises it.
    expect(isNormalizedProfileImagePath('user-1/avatar-abc-photo-normalized.webp')).toBe(false);
    expect(isNormalizedProfileImagePath('user-1/avatar-abc-photo.png')).toBe(false);
  });

  it('builds a public URL that resolves back to exactly the path and its owner', () => {
    const filePath = 'user-1/avatar-abc-photo.normalized.0123456789abcdef.webp';
    const url = buildProfileImagePublicUrl(`${PUBLIC_PROFILES}user-1/avatar-abc-photo.png#x`, filePath);

    expect(url).toBe(PUBLIC_PROFILES + filePath);
    expect(getUserOwnedStoredMediaLocation(url!, 'user-1')).toEqual({ bucket: 'profiles', filePath });
    expect(buildProfileImagePublicUrl('https://project.supabase.co/storage/v1/object/public/uploads/user-1/a.png', filePath))
      .toBeNull();
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

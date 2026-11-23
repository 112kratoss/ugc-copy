import type { SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/upload-finalization', () => ({ finalizeUploadForConsumption: vi.fn() }));
vi.mock('@/lib/upload-byte-admission', () => ({
  abortUploadByteConsumption: vi.fn(),
  completeUploadByteConsumption: vi.fn(),
}));
vi.mock('@/lib/media-upload-intents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media-upload-intents')>()),
  markMediaUploadIntentsConsumed: vi.fn(),
}));

import { markMediaUploadIntentsConsumed } from '@/lib/media-upload-intents';
import {
  SUPPORT_ATTACHMENTS_BUCKET,
  SUPPORT_PHOTO_LINK_SECONDS,
  claimStagedSupportPhoto,
  encodeSupportPhoto,
  settleStagedSupportPhoto,
  signSupportPhotoLinks,
  storeSupportPhoto,
  supportPhotoAttachmentArgument,
  toSupportPhoto,
} from '@/lib/support-photos';
import { abortUploadByteConsumption, completeUploadByteConsumption } from '@/lib/upload-byte-admission';
import { finalizeUploadForConsumption } from '@/lib/upload-finalization';

import { SUPPORT_PHOTO_MAX_BYTES } from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

type StorageCall = { bucket: string; method: string; args: unknown[] };

/** Storage alone: uploads, removes, downloads and signed links, each answering as told and recorded. */
function fakeStorage({
  uploadErrors = [] as Array<string | null>,
  download = null as Blob | null,
  signed = null as Array<{ path: string; signedUrl: string | null; error: string | null }> | null,
  removed = null as Array<{ name: string }> | null,
} = {}) {
  const calls: StorageCall[] = [];
  let upload = 0;
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async upload(...args: unknown[]) {
            calls.push({ bucket, method: 'upload', args });
            const error = uploadErrors[upload++] ?? null;
            return { data: error ? null : {}, error: error ? { message: error } : null };
          },
          async remove(paths: string[]) {
            calls.push({ bucket, method: 'remove', args: [paths] });
            return { data: removed ?? paths.map((name) => ({ name })), error: null };
          },
          async download(path: string) {
            calls.push({ bucket, method: 'download', args: [path] });
            return { data: download, error: download ? null : { message: 'gone' } };
          },
          async createSignedUrls(paths: string[], seconds: number) {
            calls.push({ bucket, method: 'createSignedUrls', args: [paths, seconds] });
            return {
              data: signed ?? paths.map((path) => ({ path, signedUrl: `https://storage.example/${path}?token=t`, error: null })),
              error: null,
            };
          },
        };
      },
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

async function jpeg(width: number, height: number, orientation?: number) {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg({ quality: 90 });
  return orientation ? image.withMetadata({ orientation }).toBuffer() : image.toBuffer();
}

beforeEach(() => {
  vi.mocked(finalizeUploadForConsumption).mockReset();
  vi.mocked(abortUploadByteConsumption).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(completeUploadByteConsumption).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(markMediaUploadIntentsConsumed).mockReset().mockResolvedValue(undefined);
});

describe('re-encoding a photo', () => {
  it('draws it upright, as WebP, at its own size and as a 720 px preview, with no metadata left', async () => {
    const result = await encodeSupportPhoto(await jpeg(1200, 600, 6));
    if (!result.ok) throw new Error('expected a photo');
    expect(result.photo).toMatchObject({ width: 600, height: 1200 });
    expect(result.photo.thumbhash).toEqual(expect.any(String));

    const full = await sharp(result.photo.full).metadata();
    const preview = await sharp(result.photo.preview).metadata();
    expect(full).toMatchObject({ format: 'webp', width: 600, height: 1200 });
    expect(preview).toMatchObject({ format: 'webp', width: 360, height: 720 });
    // Neither copy keeps the original's EXIF: a phone photo's location goes with it.
    expect(full.exif).toBeUndefined();
    expect(full.orientation).toBeUndefined();
    expect(preview.exif).toBeUndefined();
  });

  it('brings a large photo down to 2560 px a side', async () => {
    const result = await encodeSupportPhoto(await jpeg(4000, 3000));
    if (!result.ok) throw new Error('expected a photo');
    expect(result.photo).toMatchObject({ width: 2560, height: 1920 });
    expect(await sharp(result.photo.preview).metadata()).toMatchObject({ width: 720, height: 540 });
  });

  it('refuses what is not a picture it reads: text, and an SVG', async () => {
    await expect(encodeSupportPhoto(Buffer.from('not a picture'))).resolves.toEqual({ ok: false, code: 'PHOTO_UNREADABLE' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(encodeSupportPhoto(svg)).resolves.toEqual({ ok: false, code: 'PHOTO_UNREADABLE' });
  });
});

describe('keeping a photo', () => {
  const encoded = { full: Buffer.from('full-copy'), preview: Buffer.from('preview'), width: 600, height: 1200, thumbhash: 'hash=' };

  it('writes both copies as WebP under the account\'s folder, never over another', async () => {
    const { client, calls } = fakeStorage();
    const stored = await storeSupportPhoto(client, { ownerUserId: 'user-1', photo: encoded, createId: () => 'photo-1' });

    expect(stored).toEqual({
      kind: 'image',
      path: 'user-1/photo-1.webp',
      previewPath: 'user-1/photo-1.preview.webp',
      width: 600,
      height: 1200,
      bytes: encoded.full.byteLength,
      thumbhash: 'hash=',
    });
    const uploads = calls.filter((call) => call.method === 'upload');
    expect(uploads.map((call) => [call.bucket, call.args[0], (call.args[2] as Record<string, unknown>).contentType, (call.args[2] as Record<string, unknown>).upsert]))
      .toEqual([
        [SUPPORT_ATTACHMENTS_BUCKET, 'user-1/photo-1.webp', 'image/webp', false],
        [SUPPORT_ATTACHMENTS_BUCKET, 'user-1/photo-1.preview.webp', 'image/webp', false],
      ]);
    // A Blob, never a Buffer: supabase-js stringifies a Buffer.
    expect(uploads[0].args[1]).toBeInstanceOf(Blob);
    expect(supportPhotoAttachmentArgument(stored)).toEqual({
      kind: 'image',
      path: 'user-1/photo-1.webp',
      preview_path: 'user-1/photo-1.preview.webp',
      width: 600,
      height: 1200,
      bytes: encoded.full.byteLength,
      thumbhash: 'hash=',
    });
  });

  it('takes the first copy back when the second does not land', async () => {
    const { client, calls } = fakeStorage({ uploadErrors: [null, 'quota'] });
    await expect(storeSupportPhoto(client, { ownerUserId: 'user-1', photo: encoded, createId: () => 'photo-2' }))
      .rejects.toThrow(/preview/);
    expect(calls.filter((call) => call.method === 'remove').map((call) => call.args[0]))
      .toEqual([['user-1/photo-2.webp', 'user-1/photo-2.preview.webp']]);
  });
});

describe('signed links', () => {
  it('signs every copy in one call for a few hours, and leaves out one Storage could not sign', async () => {
    const { client, calls } = fakeStorage({
      signed: [
        { path: 'user-1/a.preview.webp', signedUrl: 'https://storage.example/a-preview', error: null },
        { path: 'user-1/a.webp', signedUrl: null, error: 'Object not found' },
      ],
    });
    const links = await signSupportPhotoLinks(client, ['user-1/a.preview.webp', 'user-1/a.webp', 'user-1/a.preview.webp']);
    expect(calls).toEqual([{
      bucket: SUPPORT_ATTACHMENTS_BUCKET,
      method: 'createSignedUrls',
      args: [['user-1/a.preview.webp', 'user-1/a.webp'], SUPPORT_PHOTO_LINK_SECONDS],
    }]);
    expect([...links]).toEqual([['user-1/a.preview.webp', 'https://storage.example/a-preview']]);

    const now = Date.parse('2026-11-21T10:00:00.000Z');
    expect(toSupportPhoto({ path: 'user-1/a.webp', previewPath: 'user-1/a.preview.webp', width: 10, height: 20, thumbhash: null }, links, now))
      .toEqual({
        kind: 'image',
        previewUrl: 'https://storage.example/a-preview',
        url: null,
        width: 10,
        height: 20,
        thumbhash: null,
        expiresAt: new Date(now + SUPPORT_PHOTO_LINK_SECONDS * 1000).toISOString(),
      });
  });

  it('asks Storage nothing for a thread without photos', async () => {
    const { client, calls } = fakeStorage();
    await expect(signSupportPhotoLinks(client, [])).resolves.toEqual(new Map());
    expect(calls).toEqual([]);
  });
});

describe('claiming the account\'s staged photo', () => {
  const claim = { uploadId: 'upload-1', userId: 'user-1', leaseId: 'lease-1', disposition: 'delete' as const };
  const finalized = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    descriptor: { bucket: 'uploads', path: 'user-1/upload-1-photo.jpg', storagePath: 'uploads/user-1/upload-1-photo.jpg', contentType: 'image/jpeg', sizeBytes: 1024 },
    canonicalPath: 'user-1/upload-1-photo.jpg',
    reservationId: 'upload-1',
    consumptionClaim: claim,
    ...overrides,
  });

  it('takes only a path in uploads, asking the pipeline nothing otherwise', async () => {
    const { client } = fakeStorage();
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'profiles/user-1/a.jpg' }))
      .resolves.toEqual({ ok: false, code: 'PHOTO_NOT_FOUND' });
    expect(finalizeUploadForConsumption).not.toHaveBeenCalled();
  });

  it('leases the finished upload to be deleted, and reads its bytes', async () => {
    vi.mocked(finalizeUploadForConsumption).mockResolvedValue(finalized());
    const { client, calls } = fakeStorage({ download: new Blob([new Uint8Array([1, 2, 3])]) });

    const result = await claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/upload-1-photo.jpg' });

    expect(finalizeUploadForConsumption).toHaveBeenCalledWith(client, {
      bucket: 'uploads',
      storagePath: 'user-1/upload-1-photo.jpg',
      userId: 'user-1',
      disposition: 'delete',
    });
    expect(calls).toEqual([{ bucket: 'uploads', method: 'download', args: ['user-1/upload-1-photo.jpg'] }]);
    expect(result).toEqual({ ok: true, staged: { bytes: new Uint8Array([1, 2, 3]), claim, stagedPath: 'user-1/upload-1-photo.jpg' } });
  });

  it('refuses an upload that is not there, not finished, or from before leases', async () => {
    const { client } = fakeStorage();
    vi.mocked(finalizeUploadForConsumption).mockResolvedValueOnce({ ok: false, status: 404, code: 'UPLOAD_NOT_FOUND', error: 'x' });
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/a.jpg' }))
      .resolves.toEqual({ ok: false, code: 'PHOTO_NOT_FOUND' });
    vi.mocked(finalizeUploadForConsumption).mockResolvedValueOnce({ ok: true, descriptor: null, canonicalPath: 'user-1/a.jpg', reservationId: null, consumptionClaim: null });
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/a.jpg' }))
      .resolves.toEqual({ ok: false, code: 'PHOTO_NOT_FOUND' });
    vi.mocked(finalizeUploadForConsumption).mockResolvedValueOnce({ ok: false, status: 500, code: 'UPLOAD_FINALIZATION_UNAVAILABLE', error: 'down' });
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/a.jpg' })).rejects.toThrow('down');
  });

  it('gives back an upload over the cap, or of a type the server cannot read', async () => {
    const { client } = fakeStorage();
    vi.mocked(finalizeUploadForConsumption).mockResolvedValueOnce(finalized({
      descriptor: { ...finalized().descriptor, sizeBytes: SUPPORT_PHOTO_MAX_BYTES + 1 },
    }));
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/upload-1-photo.jpg' }))
      .resolves.toEqual({ ok: false, code: 'PHOTO_TOO_LARGE' });
    vi.mocked(finalizeUploadForConsumption).mockResolvedValueOnce(finalized({
      descriptor: { ...finalized().descriptor, contentType: 'image/heic' },
    }));
    await expect(claimStagedSupportPhoto(client, { userId: 'user-1', storagePath: 'uploads/user-1/upload-1-photo.jpg' }))
      .resolves.toEqual({ ok: false, code: 'PHOTO_UNREADABLE' });
    expect(abortUploadByteConsumption).toHaveBeenCalledTimes(2);
    expect(abortUploadByteConsumption).toHaveBeenCalledWith(client, claim);
  });

  it('settles a kept photo: completes the lease, removes the staged object, marks it consumed and cleared', async () => {
    const { client, calls } = fakeStorage();
    await settleStagedSupportPhoto(client, { staged: { claim, stagedPath: 'user-1/upload-1-photo.jpg' }, userId: 'user-1' });
    expect(completeUploadByteConsumption).toHaveBeenCalledWith(client, { claim, disposition: 'delete' });
    expect(calls).toEqual([{ bucket: 'uploads', method: 'remove', args: [['user-1/upload-1-photo.jpg']] }]);
    expect(markMediaUploadIntentsConsumed).toHaveBeenCalledWith(client, {
      storagePaths: ['user-1/upload-1-photo.jpg'],
      userId: 'user-1',
      consumedBy: 'support_message',
      storageCleared: true,
    });
  });

  it('leaves a staged object Storage did not confirm removed for the sweep, consumed but not cleared', async () => {
    const { client } = fakeStorage({ removed: [] });
    await settleStagedSupportPhoto(client, { staged: { claim, stagedPath: 'user-1/upload-1-photo.jpg' }, userId: 'user-1' });
    expect(markMediaUploadIntentsConsumed).toHaveBeenCalledWith(client, expect.objectContaining({ storageCleared: false }));
  });

  it('removes nothing while its lease could not be completed', async () => {
    vi.mocked(completeUploadByteConsumption).mockResolvedValue({ ok: false, kind: 'conflict', error: 'lease lost' });
    const { client, calls } = fakeStorage();
    await settleStagedSupportPhoto(client, { staged: { claim, stagedPath: 'user-1/upload-1-photo.jpg' }, userId: 'user-1' });
    expect(calls).toEqual([]);
    expect(markMediaUploadIntentsConsumed).not.toHaveBeenCalled();
  });
});

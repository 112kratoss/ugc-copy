import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { assertStoredPreviewIsIntact } from '@/lib/media-preview-integrity';

async function encodedPreview() {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: '#654321' } }).webp({ quality: 72 }).toBuffer();
}

function md5(bytes: Buffer) {
  return createHash('md5').update(bytes).digest('hex');
}

/** Storage that answers `info` with the given ETag and size, and `download` with the stored bytes. */
function storageDouble({ stored, info }: { stored: Buffer; info: { etag?: string; size?: number } | Error | null }) {
  const download = vi.fn(async () => ({
    error: null,
    data: { arrayBuffer: async () => Uint8Array.from(stored).buffer },
  }));
  const infoCall = vi.fn(async () => {
    if (info instanceof Error) throw info;
    return info ? { data: info, error: null } : { data: null, error: { message: 'not found' } };
  });
  return {
    download,
    info: infoCall,
    supabase: { storage: { from: vi.fn(() => ({ download, info: infoCall })) } } as never,
  };
}

const location = { bucket: 'generated_images', filePath: 'user-1/output.preview.0123456789abcdef.webp' };

describe('assertStoredPreviewIsIntact', () => {
  it('proves the stored bytes by an ETag that is their MD5, at their size, without reading them back', async () => {
    const preview = await encodedPreview();
    const storage = storageDouble({ stored: preview, info: { etag: `"${md5(preview)}"`, size: preview.length } });

    await expect(assertStoredPreviewIsIntact({ supabase: storage.supabase, location, expected: preview })).resolves.toBeUndefined();

    expect(storage.download).not.toHaveBeenCalled();
  });

  it.each([
    ['an ETag of other bytes', (preview: Buffer) => ({ etag: `"${md5(Buffer.concat([preview, Buffer.from([0])]))}"`, size: preview.length })],
    ['a multipart ETag', (preview: Buffer) => ({ etag: `"${md5(preview)}-2"`, size: preview.length })],
    ['a weak ETag', (preview: Buffer) => ({ etag: `W/"${md5(preview)}"`, size: preview.length })],
    ['another size', (preview: Buffer) => ({ etag: `"${md5(preview)}"`, size: preview.length + 1 })],
    ['no ETag', (preview: Buffer) => ({ size: preview.length })],
    ['no answer', () => null],
    ['a thrown read', () => new Error('socket hang up')],
  ])('reads the bytes back when Storage answers %s', async (_label, info) => {
    const preview = await encodedPreview();
    const storage = storageDouble({ stored: preview, info: info(preview) });

    await expect(assertStoredPreviewIsIntact({ supabase: storage.supabase, location, expected: preview })).resolves.toBeUndefined();

    expect(storage.download).toHaveBeenCalledOnce();
  });

  it('still fails a corrupt file whose ETag does not prove it', async () => {
    const preview = await encodedPreview();
    const corrupt = Buffer.from(preview.toString('utf8'), 'utf8');
    const storage = storageDouble({ stored: corrupt, info: { etag: `"${md5(corrupt)}"`, size: corrupt.length } });

    await expect(assertStoredPreviewIsIntact({ supabase: storage.supabase, location, expected: preview }))
      .rejects.toThrow(/encoded/);
  });

  it('does not take an ETag as proof of bytes that are not a WebP', async () => {
    const notWebp = Buffer.from('not a webp at all');
    const storage = storageDouble({ stored: notWebp, info: { etag: `"${md5(notWebp)}"`, size: notWebp.length } });

    await expect(assertStoredPreviewIsIntact({ supabase: storage.supabase, location, expected: notWebp }))
      .rejects.toThrow('not a decodable WebP');
    expect(storage.download).toHaveBeenCalled();
  });
});

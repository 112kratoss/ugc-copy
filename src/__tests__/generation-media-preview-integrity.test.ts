import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isDecodableWebp, uploadGenerationPreview } from '@/lib/generation-media-preview';

async function encodedPreview() {
  return sharp({
    create: { width: 60, height: 80, channels: 3, background: '#123456' },
  }).webp({ quality: 72 }).toBuffer();
}

/**
 * Reproduces the production corruption: binary round-tripped through a UTF-8
 * decode, which replaces every byte that is not valid UTF-8 with U+FFFD. This is
 * exactly what four stored previews contained.
 */
function corruptViaUtf8RoundTrip(bytes: Buffer) {
  return Buffer.from(bytes.toString('utf8'), 'utf8');
}

function storageDouble({ stored }: { stored: Buffer }) {
  const upload = vi.fn(async () => ({ error: null }));
  const download = vi.fn(async () => ({
    error: null,
    data: { arrayBuffer: async () => Uint8Array.from(stored).buffer },
  }));

  return {
    upload,
    download,
    supabase: { storage: { from: vi.fn(() => ({ upload, download })) } },
  };
}

describe('storage upload body', () => {
  /**
   * The root cause, pinned. `StorageFileApi.uploadOrUpdate` only routes a Blob
   * through its multipart path; a Node Buffer matches no branch and falls through
   * to a raw body that is UTF-8 stringified in transit, inflating it ~1.8x. The
   * repair job proved it in production: 79,616 encoded bytes stored as 144,323.
   */
  it('hands storage a Blob rather than a Buffer', async () => {
    const preview = await encodedPreview();
    const { supabase, upload } = storageDouble({ stored: preview });

    await uploadGenerationPreview({
      preview,
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    });

    const [, body] = upload.mock.calls[0] as unknown as [string, unknown];
    expect(body).toBeInstanceOf(Blob);
    expect(Buffer.isBuffer(body)).toBe(false);
    expect((body as Blob).type).toBe('image/webp');
    expect((body as Blob).size).toBe(preview.length);
  });
});

describe('isDecodableWebp', () => {
  it('accepts a real sharp-encoded WebP', async () => {
    expect(isDecodableWebp(await encodedPreview())).toBe(true);
  });

  /**
   * The stored file this was built from had `EF BF BD` inside the RIFF size field,
   * which pushes "WEBP" from byte 8 to byte 10. Header bytes 4-7 are a length, so
   * whether the header itself is hit depends on the file's size — which is why the
   * length check below carries the cases this one cannot see.
   */
  it('rejects the header shift seen in the stored production file', async () => {
    const preview = await encodedPreview();
    const shifted = Buffer.concat([
      preview.subarray(0, 4),
      Buffer.from([0xef, 0xbf, 0xbd]),
      preview.subarray(5),
    ]);

    expect(isDecodableWebp(shifted)).toBe(false);
  });

  it('is not sufficient alone: small previews survive the round trip header-intact', async () => {
    const preview = await encodedPreview();
    const corrupt = corruptViaUtf8RoundTrip(preview);

    // Bytes 4-7 are a small length here, so they are valid ASCII and pass through
    // untouched; only the compressed body inflates. The header still looks fine.
    expect(corrupt.length).toBeGreaterThan(preview.length);
    expect(isDecodableWebp(corrupt)).toBe(true);
  });

  it('rejects truncated and empty payloads', () => {
    expect(isDecodableWebp(Buffer.alloc(0))).toBe(false);
    expect(isDecodableWebp(Buffer.from('RIFF'))).toBe(false);
  });
});

describe('uploadGenerationPreview integrity check', () => {
  it('returns ready when the stored bytes match what was encoded', async () => {
    const preview = await encodedPreview();
    const { supabase, download } = storageDouble({ stored: preview });

    const result = await uploadGenerationPreview({
      preview,
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    });

    expect(result).toMatchObject({ previewStatus: 'ready' });
    expect(download).toHaveBeenCalledTimes(1);
  });

  /**
   * The regression that matters: without this the caller records `ready`, and the
   * repair job only revisits pending/failed/processing — so the file stays broken
   * forever. Failing here lets the existing repair path retry it.
   */
  it('throws when the stored preview came back corrupt, rather than reporting ready', async () => {
    const preview = await encodedPreview();
    const { supabase } = storageDouble({ stored: corruptViaUtf8RoundTrip(preview) });

    await expect(uploadGenerationPreview({
      preview,
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    })).rejects.toThrow(/stored \d+ bytes but \d+ were encoded/);
  });

  it('throws when the stored preview is the right length but not a WebP', async () => {
    const preview = await encodedPreview();
    const { supabase } = storageDouble({ stored: Buffer.alloc(preview.length, 0x41) });

    await expect(uploadGenerationPreview({
      preview,
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    })).rejects.toThrow(/not a decodable WebP/);
  });

  it('throws when the object cannot be read back at all', async () => {
    const preview = await encodedPreview();
    const upload = vi.fn(async () => ({ error: null }));
    const download = vi.fn(async () => ({ error: null, data: null }));
    const supabase = { storage: { from: vi.fn(() => ({ upload, download })) } };

    await expect(uploadGenerationPreview({
      preview,
      storagePath: 'generated_images/user-1/output.jpg',
      supabase: supabase as never,
    })).rejects.toThrow(/could not be read back/);
  });
});

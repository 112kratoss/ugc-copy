import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BASE64_MAX_BYTES,
  AGENT_UPLOAD_MAX_BYTES_BY_KIND,
  agentUploadFileName,
  decodeAgentBase64,
  stageAgentInput,
  type AgentInputUploadDependencies,
} from '@/lib/agent-input-upload';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/temporary-media-upload-sign';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = '55555555-5555-4555-8555-555555555555';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(32)]);

function fakes(overrides: Partial<AgentInputUploadDependencies> = {}) {
  const upload = vi.fn(async () => ({ data: { path: 'x' }, error: null }));
  const admin = { storage: { from: vi.fn(() => ({ upload })) } } as unknown as SupabaseClient;
  const dependencies: AgentInputUploadDependencies = {
    fetchPublicHttpsMedia: vi.fn(async () => ({ ok: true as const, bytes: JPEG, contentType: 'image/jpeg', kind: 'image' as const, finalUrl: 'https://cdn.example.com/a.jpg' })),
    createTemporaryMediaUploadIntent: vi.fn(async ({ body }: { body: unknown }) => {
      const { fileName, mimeType } = body as { fileName: string; mimeType: string };
      return {
        ok: true as const,
        response: {
          success: true as const,
          uploadId: UPLOAD_ID,
          bucket: 'uploads' as const,
          path: `${USER_ID}/${UPLOAD_ID}-${fileName}`,
          storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-${fileName}`,
          token: 'signed-token',
          signedUploadUrl: null,
          expiresInSeconds: 7200,
          contentType: mimeType,
        },
      };
    }) as unknown as AgentInputUploadDependencies['createTemporaryMediaUploadIntent'],
    finalizeUploadById: vi.fn(async () => ({
      ok: true as const,
      descriptor: { bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-agent-image.jpg`, storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-agent-image.jpg`, contentType: 'image/jpeg', sizeBytes: JPEG.length },
      canonicalPath: `${USER_ID}/${UPLOAD_ID}-agent-image.jpg`,
      reservationId: UPLOAD_ID,
    })) as unknown as AgentInputUploadDependencies['finalizeUploadById'],
    createTemporaryMediaReadUrl: vi.fn(async () => ({
      ok: true as const,
      response: { success: true as const, signedUrl: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', expiresInSeconds: 3600 },
    })) as unknown as AgentInputUploadDependencies['createTemporaryMediaReadUrl'],
    ...overrides,
  };
  return { admin, upload, dependencies };
}

describe('the base64 source', () => {
  it('decodes standard base64 and a data URL under the policy\'s types and the 8 MB cap', () => {
    const plain = decodeAgentBase64(JPEG.toString('base64'), 'image/jpeg');
    expect(plain).toMatchObject({ ok: true, contentType: 'image/jpeg', kind: 'image' });
    expect(plain.ok && plain.bytes.equals(JPEG)).toBe(true);

    const dataUrl = decodeAgentBase64(`data:image/jpeg;base64,${JPEG.toString('base64')}`, '');
    expect(dataUrl).toMatchObject({ ok: true, contentType: 'image/jpeg' });

    // A picker's alias reads as the listed name; whitespace inside the payload is ignored.
    const aliased = decodeAgentBase64(WAV.toString('base64').replace(/(.{20})/gu, '$1\n'), 'audio/vnd.wave');
    expect(aliased).toMatchObject({ ok: true, contentType: 'audio/wav', kind: 'audio' });

    expect(AGENT_BASE64_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(decodeAgentBase64('not base64!!', 'image/jpeg')).toMatchObject({ ok: false, code: 'INVALID_BASE64' });
    expect(decodeAgentBase64('', 'image/jpeg')).toMatchObject({ ok: false, code: 'INVALID_BASE64' });
    expect(decodeAgentBase64(JPEG.toString('base64'), 'text/html')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'text/html' } });
    expect(decodeAgentBase64(JPEG.toString('base64'), 'image/svg+xml')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });
    // The size follows from the length: the cap is applied before anything is decoded.
    const huge = `${'A'.repeat(Math.ceil((AGENT_BASE64_MAX_BYTES + 3) / 3) * 4)}`;
    expect(decodeAgentBase64(huge, 'image/png')).toMatchObject({ ok: false, code: 'TOO_LARGE', details: { max_bytes: AGENT_BASE64_MAX_BYTES } });
    // The bytes say what they are: a track sent as a picture is refused.
    expect(decodeAgentBase64(WAV.toString('base64'), 'image/png')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: 'audio' } });
  });

  it('files a staged object under a fixed name, never the agent\'s words', () => {
    expect(agentUploadFileName('image', 'image/jpeg')).toBe('agent-image.jpg');
    expect(agentUploadFileName('video', 'video/quicktime')).toBe('agent-video.mov');
    expect(agentUploadFileName('audio', 'audio/mp4')).toBe('agent-audio.m4a');
    expect(agentUploadFileName('image', 'image/x-unknown')).toBe('agent-image.x-unknown');
  });

  it('keeps the sign step\'s own caps (the browser\'s TEMPORARY_MEDIA_UPLOAD_LIMITS mirror them)', () => {
    // Not read from temporary-media-upload.ts, which makes the browser client at import; the sign
    // step's constants are the server's own, and temporary-media-upload.test.ts holds the mirror.
    expect(AGENT_UPLOAD_MAX_BYTES_BY_KIND).toEqual(MAX_UPLOAD_BYTES_BY_KIND);
    expect(AGENT_UPLOAD_MAX_BYTES_BY_KIND).toEqual({ image: 25 * 1024 * 1024, video: 250 * 1024 * 1024, audio: 50 * 1024 * 1024 });
  });
});

describe('stageAgentInput', () => {
  it('stages a fetched file through sign, a Blob upload, finalize and a signed read URL, and answers the run input', async () => {
    const { admin, upload, dependencies } = fakes();
    const result = await stageAgentInput({ admin, userId: USER_ID, source: { url: 'https://cdn.example.com/a.jpg' }, dependencies });
    expect(result).toEqual({
      ok: true,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-agent-image.jpg` },
      kind: 'image',
      bytes: JPEG.length,
      mimeType: 'image/jpeg',
      expiresInSeconds: 3600,
      sourceUrl: 'https://cdn.example.com/a.jpg',
    });
    expect(dependencies.fetchPublicHttpsMedia).toHaveBeenCalledWith('https://cdn.example.com/a.jpg', { maxBytesByKind: AGENT_UPLOAD_MAX_BYTES_BY_KIND });
    // The sign step is given the bytes as they are: their type, their kind and their real size.
    const [{ body, userId }] = vi.mocked(dependencies.createTemporaryMediaUploadIntent).mock.calls[0] as unknown as [{ body: Record<string, unknown>; userId: string }];
    expect(body).toEqual({ fileName: 'agent-image.jpg', mimeType: 'image/jpeg', kind: 'image', sizeBytes: JPEG.length });
    expect(userId).toBe(USER_ID);
    // The bytes go up as a Blob under the type the sign step kept, to the reserved path, never over an existing object.
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, blob, options] = upload.mock.calls[0] as unknown as [string, Blob, { contentType: string; upsert: boolean }];
    expect(path).toBe(`${USER_ID}/${UPLOAD_ID}-agent-image.jpg`);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    expect(Buffer.from(await blob.arrayBuffer()).equals(JPEG)).toBe(true);
    expect(options).toEqual({ contentType: 'image/jpeg', upsert: false });
    expect(dependencies.finalizeUploadById).toHaveBeenCalledWith(admin, { uploadId: UPLOAD_ID, userId: USER_ID });
    expect(dependencies.createTemporaryMediaReadUrl).toHaveBeenCalledWith(expect.objectContaining({
      body: { storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-agent-image.jpg` },
      userId: USER_ID,
    }));
  });

  it('stages base64 bytes the same way, with no source URL', async () => {
    const { admin, dependencies } = fakes();
    const result = await stageAgentInput({ admin, userId: USER_ID, source: { base64: JPEG.toString('base64'), mimeType: 'image/jpeg' }, dependencies });
    expect(result).toMatchObject({ ok: true, kind: 'image', sourceUrl: null });
    expect(dependencies.fetchPublicHttpsMedia).not.toHaveBeenCalled();
  });

  it('passes the fetch\'s refusal on untouched, before anything is reserved', async () => {
    const { admin, dependencies } = fakes({
      fetchPublicHttpsMedia: vi.fn(async () => ({ ok: false as const, code: 'PRIVATE_ADDRESS' as const, message: 'nope', details: { host: 'x' } })),
    });
    expect(await stageAgentInput({ admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies }))
      .toEqual({ ok: false, code: 'PRIVATE_ADDRESS', message: 'nope', details: { host: 'x' } });
    expect(dependencies.createTemporaryMediaUploadIntent).not.toHaveBeenCalled();
  });

  it('maps the sign step\'s refusals: the rate limit with its wait, a deleting account, and the rest as failures', async () => {
    const limited = fakes({
      createTemporaryMediaUploadIntent: vi.fn(async () => ({ ok: false as const, status: 429, code: 'RATE_LIMITED', error: 'Too many', retryAfterSeconds: 45 })) as never,
    });
    expect(await stageAgentInput({ admin: limited.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: limited.dependencies }))
      .toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 45 });
    expect(limited.upload).not.toHaveBeenCalled();

    const deleting = fakes({
      createTemporaryMediaUploadIntent: vi.fn(async () => ({ ok: false as const, status: 409, code: 'ACCOUNT_DELETION_IN_PROGRESS', error: 'Deleting.' })) as never,
    });
    expect(await stageAgentInput({ admin: deleting.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: deleting.dependencies }))
      .toMatchObject({ ok: false, code: 'ACCOUNT_DELETION_IN_PROGRESS' });

    const broken = fakes({
      createTemporaryMediaUploadIntent: vi.fn(async () => ({ ok: false as const, status: 500, error: 'Failed to prepare media upload.' })) as never,
    });
    expect(await stageAgentInput({ admin: broken.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: broken.dependencies }))
      .toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
  });

  it('answers a failed store, a finalize mismatch and a failed read URL without a half-made input', async () => {
    const failedUpload = fakes();
    failedUpload.upload.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } } as never);
    expect(await stageAgentInput({ admin: failedUpload.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: failedUpload.dependencies }))
      .toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    expect(failedUpload.dependencies.finalizeUploadById).not.toHaveBeenCalled();

    const mismatch = fakes({
      finalizeUploadById: vi.fn(async () => ({ ok: false as const, status: 400, code: 'UPLOAD_METADATA_MISMATCH' as const, error: 'The stored object does not match.' })) as never,
    });
    expect(await stageAgentInput({ admin: mismatch.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: mismatch.dependencies }))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { finalize_code: 'UPLOAD_METADATA_MISMATCH' } });
    expect(mismatch.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();

    const unreadable = fakes({
      createTemporaryMediaReadUrl: vi.fn(async () => ({ ok: false as const, status: 500, error: 'Failed to prepare media preview.' })) as never,
    });
    expect(await stageAgentInput({ admin: unreadable.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: unreadable.dependencies }))
      .toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
  });
});

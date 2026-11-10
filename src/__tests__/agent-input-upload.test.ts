import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_BASE64_MAX_BYTES,
  AGENT_BASE64_MAX_CHARACTERS,
  AGENT_OPEN_UPLOADS_MAX,
  AGENT_SIGNATURE_HEAD_BYTES,
  AGENT_URL_FETCH_MAX_BYTES_BY_KIND,
  VERCEL_REQUEST_BODY_LIMIT_BYTES,
  agentUploadCurlCommand,
  agentUploadFileName,
  decodeAgentBase64,
  isStoredObjectMissing,
  readAgentStagedUploads,
  readAgentUploadIntent,
  readStoredObjectHead,
  requestAgentUpload,
  stageAgentInput,
  type AgentInputUploadDependencies,
  type AgentUploadIntent,
} from '@/lib/agent-input-upload';
import { SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS } from '@/lib/showcase-media-cache';
import { MAX_UPLOAD_BYTES_BY_KIND } from '@/lib/temporary-media-upload-sign';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const UPLOAD_ID = '55555555-5555-4555-8555-555555555555';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(32)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(52)]);

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
    // No upload is read unless a test names one: finalize then answers, as for an unknown id.
    readAgentUploadIntent: vi.fn(async () => null),
    isStoredObjectMissing: vi.fn(async () => false),
    readStoredObjectHead: vi.fn(async () => JPEG),
    deleteReservedObjectAndConfirm: vi.fn(async () => true),
    ...overrides,
  };
  return { admin, upload, dependencies };
}

/** What finalize answers for a file stored under an upload: its path, its type and its size. */
function finalizedAs(contentType: string, fileName: string, overrides: Record<string, unknown> = {}) {
  const filePath = `${USER_ID}/${UPLOAD_ID}-${fileName}`;
  return {
    ok: true as const,
    descriptor: { bucket: 'uploads', path: filePath, storagePath: `uploads/${filePath}`, contentType, sizeBytes: 2048, ...overrides },
    canonicalPath: filePath,
    reservationId: UPLOAD_ID,
  };
}

/** An upload as its reservation records it, signed for a file of this type and name. */
function intentFor(contentType: string, fileName: string, overrides: Partial<AgentUploadIntent> = {}): AgentUploadIntent {
  return { bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-${fileName}`, status: 'issued', declaredType: contentType, ...overrides };
}

/** The agent sent a file to its upload: the reservation is open, and finalize will take the file. */
function sent(contentType: string, fileName: string, intent: Partial<AgentUploadIntent> = {}): Partial<AgentInputUploadDependencies> {
  return {
    readAgentUploadIntent: vi.fn(async () => intentFor(contentType, fileName, intent)),
    finalizeUploadById: vi.fn(async () => finalizedAs(contentType, fileName)) as never,
  };
}

/** The order two fakes were first called in. */
function calledBefore(first: unknown, second: unknown): boolean {
  const [a] = vi.mocked(first as () => unknown).mock.invocationCallOrder;
  const [b] = vi.mocked(second as () => unknown).mock.invocationCallOrder;
  return a !== undefined && b !== undefined && a < b;
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

    // 3 MB decoded: Vercel caps a request body at 4.5 MB, and the encoding plus the JSON-RPC
    // envelope must fit under it, or the agent gets a platform 413 instead of TOO_LARGE.
    expect(AGENT_BASE64_MAX_BYTES).toBe(3 * 1024 * 1024);
    expect(AGENT_BASE64_MAX_CHARACTERS).toBe(Math.ceil(AGENT_BASE64_MAX_BYTES / 3) * 4 + 64);
    expect(AGENT_BASE64_MAX_CHARACTERS + 4096).toBeLessThan(VERCEL_REQUEST_BODY_LIMIT_BYTES);
    expect(decodeAgentBase64('not base64!!', 'image/jpeg')).toMatchObject({ ok: false, code: 'INVALID_BASE64' });
    expect(decodeAgentBase64('', 'image/jpeg')).toMatchObject({ ok: false, code: 'INVALID_BASE64' });
    expect(decodeAgentBase64(JPEG.toString('base64'), 'text/html')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'text/html' } });
    expect(decodeAgentBase64(JPEG.toString('base64'), 'image/svg+xml')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });
    // The size follows from the length: the cap is applied before anything is decoded.
    const huge = `${'A'.repeat(Math.ceil((AGENT_BASE64_MAX_BYTES + 3) / 3) * 4)}`;
    expect(decodeAgentBase64(huge, 'image/png')).toMatchObject({ ok: false, code: 'TOO_LARGE', details: { max_bytes: AGENT_BASE64_MAX_BYTES } });
    // The bytes say what they are: a track sent as a picture is refused, and so are bytes with no
    // picture's signature under a picture's type; a track with no signature keeps its type.
    expect(decodeAgentBase64(WAV.toString('base64'), 'image/png')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: 'audio' } });
    expect(decodeAgentBase64(Buffer.alloc(40, 7).toString('base64'), 'image/png')).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: null } });
    expect(decodeAgentBase64(Buffer.alloc(40, 7).toString('base64'), 'audio/aac')).toMatchObject({ ok: true, kind: 'audio' });
  });

  it('files a staged object under a fixed name, never the agent\'s words', () => {
    expect(agentUploadFileName('image', 'image/jpeg')).toBe('agent-image.jpg');
    expect(agentUploadFileName('video', 'video/quicktime')).toBe('agent-video.mov');
    expect(agentUploadFileName('audio', 'audio/mp4')).toBe('agent-audio.m4a');
    expect(agentUploadFileName('image', 'image/x-unknown')).toBe('agent-image.x-unknown');
  });

  it('caps a URL fetch below the sign step\'s own caps: the whole file is buffered in a 60-second function', () => {
    expect(AGENT_URL_FETCH_MAX_BYTES_BY_KIND).toEqual({ image: 25 * 1024 * 1024, video: 50 * 1024 * 1024, audio: 50 * 1024 * 1024 });
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(AGENT_URL_FETCH_MAX_BYTES_BY_KIND[kind]).toBeLessThanOrEqual(MAX_UPLOAD_BYTES_BY_KIND[kind]);
    }
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
    expect(dependencies.fetchPublicHttpsMedia).toHaveBeenCalledWith('https://cdn.example.com/a.jpg', { maxBytesByKind: AGENT_URL_FETCH_MAX_BYTES_BY_KIND });
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

    // The account's staging space is held by its open uploads: not a failure that passes in a
    // moment, so it is named, with how many uploads may be open and what frees one.
    const full = fakes({
      createTemporaryMediaUploadIntent: vi.fn(async () => ({
        ok: false as const, status: 429, code: 'UPLOAD_BYTES_LIMIT', error: 'Too many upload bytes are already reserved. Finish or retry these uploads later.',
      })) as never,
    });
    const refused = await stageAgentInput({ admin: full.admin, userId: USER_ID, source: { url: 'https://x/a.jpg' }, dependencies: full.dependencies });
    expect(refused).toMatchObject({ ok: false, code: 'UPLOAD_BYTES_LIMIT', details: { open_uploads_max: 4 } });
    expect(!refused.ok && refused.message).toMatch(/4 at most at once.*until upload_input has staged it.*can take a day/u);
    expect(full.upload).not.toHaveBeenCalled();
    // One gibibyte an account, the bucket's 250 MB worst case reserved per signed upload: four.
    expect(AGENT_OPEN_UPLOADS_MAX).toBe(4);
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

describe('the upload_id source', () => {
  const stage = (made: ReturnType<typeof fakes>) => (
    stageAgentInput({ admin: made.admin, userId: USER_ID, source: { uploadId: UPLOAD_ID }, dependencies: made.dependencies })
  );

  it('reads the upload, holds the stored file to the signature rule, then finalizes it for the caller and answers the same input', async () => {
    const made = fakes(sent('image/jpeg', 'cat.jpg'));
    expect(await stage(made)).toEqual({
      ok: true,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-cat.jpg` },
      kind: 'image',
      bytes: 2048,
      mimeType: 'image/jpeg',
      expiresInSeconds: 3600,
      sourceUrl: null,
    });
    // The upload is read, and finalized, by its id and the caller's own: another account's id is no upload.
    expect(made.dependencies.readAgentUploadIntent).toHaveBeenCalledWith(made.admin, { uploadId: UPLOAD_ID, userId: USER_ID });
    expect(made.dependencies.finalizeUploadById).toHaveBeenCalledTimes(1);
    expect(made.dependencies.finalizeUploadById).toHaveBeenCalledWith(made.admin, { uploadId: UPLOAD_ID, userId: USER_ID });
    // The rule reads the stored object once, at the path the upload was signed for, before finalize:
    // a file that fails it is never finalized, and only a finalized upload can become a post.
    expect(made.dependencies.readStoredObjectHead).toHaveBeenCalledTimes(1);
    expect(made.dependencies.readStoredObjectHead).toHaveBeenCalledWith(made.admin, expect.objectContaining({ bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-cat.jpg` }));
    expect(calledBefore(made.dependencies.readStoredObjectHead, made.dependencies.finalizeUploadById)).toBe(true);
    expect(made.dependencies.createTemporaryMediaReadUrl).toHaveBeenCalledWith(expect.objectContaining({
      body: { storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-cat.jpg` },
      userId: USER_ID,
    }));
    expect(made.dependencies.fetchPublicHttpsMedia).not.toHaveBeenCalled();
    expect(made.dependencies.createTemporaryMediaUploadIntent).not.toHaveBeenCalled();
    expect(made.upload).not.toHaveBeenCalled();
    expect(made.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();

    // Asked again about an upload already staged, it checks the file again and answers it again.
    const again = fakes(sent('image/jpeg', 'cat.jpg', { status: 'finalized' }));
    expect(await stage(again)).toMatchObject({ ok: true, kind: 'image' });
    expect(again.dependencies.isStoredObjectMissing).not.toHaveBeenCalled();
    expect(again.dependencies.readStoredObjectHead).toHaveBeenCalledTimes(1);
  });

  it('answers an upload nothing was sent to yet as not ready, and leaves it open for the file', async () => {
    const made = fakes({ ...sent('image/png', 'cat.png'), isStoredObjectMissing: vi.fn(async () => true) });
    const result = await stage(made);
    expect(result).toMatchObject({ ok: false, code: 'NOT_READY', details: { upload_id: UPLOAD_ID } });
    expect(!result.ok && result.message).toMatch(/Nothing is stored for upload .* yet\. Run the command request_upload gave.*call upload_input again/u);
    expect(made.dependencies.isStoredObjectMissing).toHaveBeenCalledWith(made.admin, expect.objectContaining({ bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-cat.png` }));
    // Finalize closes an upload it finds empty for good, and the upload keeps its staging space
    // until the reclaim: an early call must not cost the agent the upload, so finalize is not run.
    expect(made.dependencies.finalizeUploadById).not.toHaveBeenCalled();
    expect(made.dependencies.readStoredObjectHead).not.toHaveBeenCalled();
    expect(made.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('answers an unknown id, another account\'s, a closed upload and one already used with a clear code, touching nothing', async () => {
    const cases: Array<[AgentUploadIntent | null, { status: number; code: string; error: string }, string, RegExp]> = [
      // No upload under this id for the caller: an unknown id, and another account's, answer alike.
      [null, { status: 404, code: 'UPLOAD_NOT_FOUND', error: 'Upload intent not found.' }, 'NOT_FOUND', /No upload .* exists for this creator\. request_upload gives an upload_id/u],
      // Closed earlier (refused, or removed): the agent starts again.
      [intentFor('image/png', 'cat.png', { status: 'deleted' }), { status: 400, code: 'UPLOAD_NOT_FOUND', error: 'That upload is no longer available.' }, 'NOT_FOUND', /holds no file and is closed.*Call request_upload again/u],
      // Used by a post or a run.
      [intentFor('image/png', 'cat.png', { status: 'consumed' }), { status: 409, code: 'UPLOAD_NOT_READY', error: 'That upload was already consumed with a non-reusable disposition.' }, 'CONFLICT', /already used or being collected: That upload was already consumed/u],
      // The read of the upload failed: finalize answers, here that it could not load it either.
      [null, { status: 500, code: 'UPLOAD_FINALIZATION_UNAVAILABLE', error: 'Failed to load the upload intent.' }, 'UPLOAD_FAILED', /Failed to load the upload intent/u],
    ];
    for (const [intent, answer, code, words] of cases) {
      const made = fakes({
        readAgentUploadIntent: vi.fn(async () => intent),
        finalizeUploadById: vi.fn(async () => ({ ok: false as const, ...answer })) as never,
      });
      const result = await stage(made);
      expect(result, answer.error).toMatchObject({ ok: false, code, details: { upload_id: UPLOAD_ID, finalize_code: answer.code } });
      expect(!result.ok && result.message, answer.error).toMatch(words);
      // An upload that cannot be finalized any more is not looked at: nothing is read or removed.
      expect(made.dependencies.isStoredObjectMissing, answer.error).not.toHaveBeenCalled();
      expect(made.dependencies.readStoredObjectHead, answer.error).not.toHaveBeenCalled();
      expect(made.dependencies.createTemporaryMediaReadUrl, answer.error).not.toHaveBeenCalled();
      expect(made.dependencies.deleteReservedObjectAndConfirm, answer.error).not.toHaveBeenCalled();
    }

    // The file's bytes pass, but its stored size or type is not the declared one: finalize removes it itself.
    const mismatch = fakes({
      ...sent('image/jpeg', 'cat.jpg'),
      finalizeUploadById: vi.fn(async () => ({ ok: false as const, status: 400, code: 'UPLOAD_METADATA_MISMATCH', error: 'Uploaded object metadata did not match the server-issued upload intent.' })) as never,
    });
    const refused = await stage(mismatch);
    expect(refused).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { finalize_code: 'UPLOAD_METADATA_MISMATCH' } });
    expect(!refused.ok && refused.message).toMatch(/exact size_bytes and mime_type/u);
    expect(mismatch.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('removes a stored file whose bytes are not what its type says before it is ever finalized, and closes its upload', async () => {
    // A picture's type over a track's bytes.
    const track = fakes({ ...sent('image/png', 'cat.png'), readStoredObjectHead: vi.fn(async () => WAV) });
    const refused = await stage(track);
    expect(refused).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { upload_id: UPLOAD_ID, mime_type: 'image/png', sniffed_kind: 'audio' } });
    expect(!refused.ok && refused.message).toContain('request_upload was told image/png, but the file\'s bytes are a track. It was removed');
    expect(track.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledWith(track.admin, 'uploads', `${USER_ID}/${UPLOAD_ID}-cat.png`);
    // Finalize runs once, after the removal: it finds nothing stored and closes the upload, as it
    // closes one nothing was sent to. The failing file was never finalized.
    expect(track.dependencies.finalizeUploadById).toHaveBeenCalledTimes(1);
    expect(calledBefore(track.dependencies.deleteReservedObjectAndConfirm, track.dependencies.finalizeUploadById)).toBe(true);
    expect(track.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();

    // A picture's type over bytes with no picture's signature: a page saved under a picture's name.
    const page = fakes({
      ...sent('image/png', 'page.png'),
      readStoredObjectHead: vi.fn(async () => Buffer.from('<!doctype html><html><body>hello there</body></html>')),
    });
    expect(await stage(page)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: null } });
    expect(page.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledTimes(1);

    // A picture's type over a file with no bytes at all.
    const empty = fakes({ ...sent('image/png', 'empty.png'), readStoredObjectHead: vi.fn(async () => Buffer.alloc(0)) });
    expect(await stage(empty)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: null } });

    // A clip's type over a picture's bytes.
    const still = fakes(sent('video/mp4', 'clip.mp4'));
    expect(await stage(still)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'video/mp4', sniffed_kind: 'image' } });
    expect(still.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledTimes(1);

    // A clip with a clip's signature, and a track of a format with no signature, keep their type,
    // as the other two sources keep them. A picker's alias is judged as the type it names.
    const clip = fakes({ ...sent('video/mp4', 'clip.mp4'), readStoredObjectHead: vi.fn(async () => MP4) });
    expect(await stage(clip)).toMatchObject({ ok: true, kind: 'video', mimeType: 'video/mp4' });
    const plain = fakes({
      readAgentUploadIntent: vi.fn(async () => intentFor('audio/x-m4a', 'voice.m4a')),
      finalizeUploadById: vi.fn(async () => finalizedAs('audio/mp4', 'voice.m4a')) as never,
      readStoredObjectHead: vi.fn(async () => Buffer.alloc(64, 7)),
    });
    expect(await stage(plain)).toMatchObject({ ok: true, kind: 'audio', mimeType: 'audio/mp4' });
    expect(plain.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('finalizes nothing it could not check, and nothing whose removal failed', async () => {
    const unreadable = fakes({ ...sent('image/png', 'cat.png'), readStoredObjectHead: vi.fn(async () => null) });
    // The file may be fine: the same call may pass in a moment, so it stays where it is, unfinalized.
    expect(await stage(unreadable)).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    expect(unreadable.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
    expect(unreadable.dependencies.finalizeUploadById).not.toHaveBeenCalled();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stuck = fakes({
      ...sent('image/png', 'cat.png'),
      readStoredObjectHead: vi.fn(async () => WAV),
      deleteReservedObjectAndConfirm: vi.fn(async () => false),
    });
    expect(await stage(stuck)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });
    // The file that failed the rule is still stored, so its upload is neither closed nor finalized:
    // no post can be made from it, and the reclaim sweep takes it.
    expect(stuck.dependencies.finalizeUploadById).not.toHaveBeenCalled();
    expect(stuck.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('applies the rule after finalize where the upload could not be read first', async () => {
    // The read of the upload failed, finalize went through: the file is checked before it is answered.
    const late = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png')) as never,
      readStoredObjectHead: vi.fn(async () => WAV),
    });
    expect(await stage(late)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'image/png', sniffed_kind: 'audio' } });
    expect(late.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledWith(late.admin, 'uploads', `${USER_ID}/${UPLOAD_ID}-cat.png`);
    // Finalized, then closed by a second finalize once the file is gone.
    expect(late.dependencies.finalizeUploadById).toHaveBeenCalledTimes(2);
    expect(late.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();

    const fine = fakes({ finalizeUploadById: vi.fn(async () => finalizedAs('image/jpeg', 'cat.jpg')) as never });
    expect(await stage(fine)).toMatchObject({ ok: true, kind: 'image' });
    expect(fine.dependencies.readStoredObjectHead).toHaveBeenCalledTimes(1);
  });

  it('takes only an upload staged in the uploads bucket', async () => {
    // A reservation of the creator's in another bucket (a recipe file) is no staged input.
    const elsewhere = fakes({
      readAgentUploadIntent: vi.fn(async () => intentFor('image/png', 'cat.png', { bucket: 'post_resource_files' })),
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png', { bucket: 'post_resource_files' })) as never,
    });
    expect(await stage(elsewhere)).toMatchObject({ ok: false, code: 'NOT_FOUND', details: { upload_id: UPLOAD_ID } });
    expect(elsewhere.dependencies.readStoredObjectHead).not.toHaveBeenCalled();
    expect(elsewhere.dependencies.isStoredObjectMissing).not.toHaveBeenCalled();
  });
});

describe('reading an upload before finalize', () => {
  function client(row: unknown, rowError: unknown = null) {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: row, error: rowError })),
    };
    return { admin: { from: vi.fn(() => query) } as unknown as SupabaseClient, query };
  }
  function storage(info: { data?: unknown; error: unknown }) {
    const objectInfo = vi.fn(async () => info);
    const from = vi.fn(() => ({ info: objectInfo }));
    return { admin: { storage: { from } } as unknown as SupabaseClient, from, objectInfo };
  }
  const row = { bucket_id: 'uploads', storage_path: `${USER_ID}/${UPLOAD_ID}-cat.png`, finalization_status: 'issued', expected_content_type: 'image/png' };

  it('reads the upload by its id and the caller\'s own, and nothing for another\'s, an unknown one or a failed read', async () => {
    const found = client(row);
    expect(await readAgentUploadIntent(found.admin, { uploadId: UPLOAD_ID, userId: USER_ID }))
      .toEqual({ bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-cat.png`, status: 'issued', declaredType: 'image/png' });
    expect(vi.mocked(found.admin.from)).toHaveBeenCalledWith('upload_byte_reservations');
    expect(found.query.select).toHaveBeenCalledWith('bucket_id, storage_path, finalization_status, expected_content_type');
    // The owner is part of the read: another account's id finds no row.
    expect(found.query.eq.mock.calls).toEqual([['id', UPLOAD_ID], ['user_id', USER_ID]]);

    expect(await readAgentUploadIntent(client(null).admin, { uploadId: UPLOAD_ID, userId: OTHER_USER_ID })).toBeNull();
    expect(await readAgentUploadIntent(client(null, { message: 'down' }).admin, { uploadId: UPLOAD_ID, userId: USER_ID })).toBeNull();
    const thrown = client(row);
    thrown.query.maybeSingle.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await readAgentUploadIntent(thrown.admin, { uploadId: UPLOAD_ID, userId: USER_ID })).toBeNull();
  });

  it('calls a path empty only on Storage\'s own not-found, never on a failed read', async () => {
    const location = { bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-cat.png` };
    const missing = storage({ data: null, error: { statusCode: '404', message: 'Object not found' } });
    expect(await isStoredObjectMissing(missing.admin, location)).toBe(true);
    expect(missing.from).toHaveBeenCalledWith('uploads');
    expect(missing.objectInfo).toHaveBeenCalledWith(`${USER_ID}/${UPLOAD_ID}-cat.png`);
    expect(await isStoredObjectMissing(storage({ data: null, error: { status: 404 } }).admin, location)).toBe(true);
    // The file arrived.
    expect(await isStoredObjectMissing(storage({ data: { id: 'object-1', size: 10 }, error: null }).admin, location)).toBe(false);
    // Storage failed for a reason that is not absence: finalize is left to answer.
    expect(await isStoredObjectMissing(storage({ data: null, error: { statusCode: '500', message: 'storage down' } }).admin, location)).toBe(false);
    const thrown = storage({ data: null, error: null });
    thrown.objectInfo.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await isStoredObjectMissing(thrown.admin, location)).toBe(false);
  });
});

describe('readStoredObjectHead', () => {
  const SIGNED = 'https://project.supabase.test/storage/v1/object/sign/uploads/u/a.mp4?token=t';

  function storage(signedUrl: string | null, error: unknown = null) {
    const createSignedUrl = vi.fn(async () => ({ data: signedUrl ? { signedUrl } : null, error }));
    const from = vi.fn(() => ({ createSignedUrl }));
    return { admin: { storage: { from } } as unknown as SupabaseClient, from, createSignedUrl };
  }

  it('reads the first 64 bytes through a one-minute signed URL with a Range header, and stops reading there', async () => {
    const { admin, from, createSignedUrl } = storage(SIGNED);
    const whole = Buffer.concat([MP4, Buffer.alloc(100_000, 9)]);
    let offset = 0;
    // A server that ignores Range and streams the whole object.
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = whole.subarray(offset, offset + 16);
        offset += 16;
        if (chunk.length === 0) controller.close();
        else controller.enqueue(new Uint8Array(chunk));
      },
    }), { status: 200 }));

    const head = await readStoredObjectHead(admin, { bucket: 'uploads', path: 'u/a.mp4' }, fetchImpl as unknown as typeof fetch);
    expect(head?.length).toBe(AGENT_SIGNATURE_HEAD_BYTES);
    expect(head?.equals(whole.subarray(0, AGENT_SIGNATURE_HEAD_BYTES))).toBe(true);
    expect(from).toHaveBeenCalledWith('uploads');
    expect(createSignedUrl).toHaveBeenCalledWith('u/a.mp4', 60);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SIGNED);
    expect(init?.headers).toEqual({ range: 'bytes=0-63' });
    expect(AGENT_SIGNATURE_HEAD_BYTES).toBe(64);
    // The rest of the object was never pulled.
    expect(offset).toBeLessThan(1024);
  });

  it('answers a short object whole, and null when the URL cannot be signed, the read is refused or it fails', async () => {
    const short = storage(SIGNED);
    const five = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 206 }));
    expect((await readStoredObjectHead(short.admin, { bucket: 'uploads', path: 'u/a' }, five as unknown as typeof fetch))?.length).toBe(5);

    const unsigned = storage(null, { message: 'Object not found' });
    const never = vi.fn();
    expect(await readStoredObjectHead(unsigned.admin, { bucket: 'uploads', path: 'u/a' }, never as unknown as typeof fetch)).toBeNull();
    expect(never).not.toHaveBeenCalled();

    // A file with no bytes has no first bytes: Storage cannot satisfy the range, and the head is empty,
    // so a picture's type over it fails the rule instead of asking the agent to try again for ever.
    const none = vi.fn(async () => new Response(null, { status: 416 }));
    const empty = await readStoredObjectHead(storage(SIGNED).admin, { bucket: 'uploads', path: 'u/a' }, none as unknown as typeof fetch);
    expect(empty).not.toBeNull();
    expect(empty?.length).toBe(0);

    const refused = vi.fn(async () => new Response('no', { status: 404 }));
    expect(await readStoredObjectHead(storage(SIGNED).admin, { bucket: 'uploads', path: 'u/a' }, refused as unknown as typeof fetch)).toBeNull();
    const broken = vi.fn(async () => { throw new Error('socket hang up'); });
    expect(await readStoredObjectHead(storage(SIGNED).admin, { bucket: 'uploads', path: 'u/a' }, broken as unknown as typeof fetch)).toBeNull();
  });
});

describe('requestAgentUpload', () => {
  const MB = 1024 * 1024;

  it('signs an upload for the declared file through the sign step and answers where and how to send it', async () => {
    const signedUploadUrl = `https://project.supabase.test/storage/v1/object/upload/sign/uploads/${USER_ID}/${UPLOAD_ID}-my-cat.png?token=signed-token`;
    const { admin, dependencies } = fakes({
      createTemporaryMediaUploadIntent: vi.fn(async ({ body }: { body: unknown }) => ({
        ok: true as const,
        response: {
          success: true as const,
          uploadId: UPLOAD_ID,
          bucket: 'uploads' as const,
          path: `${USER_ID}/${UPLOAD_ID}-my-cat.png`,
          storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-my-cat.png`,
          token: 'signed-token',
          signedUploadUrl,
          expiresInSeconds: 7200,
          contentType: (body as { mimeType: string }).mimeType,
        },
      })) as never,
    });
    const result = await requestAgentUpload({ admin, userId: USER_ID, request: { fileName: 'My Cat.PNG', mimeType: 'image/png', sizeBytes: 123_456 }, dependencies });
    expect(result).toEqual({
      ok: true,
      uploadId: UPLOAD_ID,
      uploadUrl: signedUploadUrl,
      // The headers the web's own upload sends: the type finalize checks, no overwrite, and the
      // cache lifetime a published copy keeps.
      headers: { 'content-type': 'image/png', 'x-upsert': 'false', 'cache-control': `max-age=${SHOWCASE_PUBLIC_MEDIA_CACHE_TTL_SECONDS}` },
      storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-my-cat.png`,
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 123_456,
      expiresInSeconds: 7200,
      maxBytes: 25 * MB,
    });
    expect(result.ok && result.headers['cache-control']).toBe('max-age=86400');
    // The sign step is given the file as declared, for the caller: its name (which the sign step
    // cleans and judges), its type, its kind and its exact size.
    const [{ body, userId }] = vi.mocked(dependencies.createTemporaryMediaUploadIntent).mock.calls[0] as unknown as [{ body: Record<string, unknown>; userId: string }];
    expect(body).toEqual({ fileName: 'My Cat.PNG', mimeType: 'image/png', kind: 'image', sizeBytes: 123_456 });
    expect(userId).toBe(USER_ID);
    // Nothing is stored or finalized by the request itself.
    expect(dependencies.finalizeUploadById).not.toHaveBeenCalled();
  });

  it('builds the URL from the token when the sign step answers none, and offers no upload it cannot address', async () => {
    const { admin, dependencies } = fakes();
    const request = { fileName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 1024 };
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test/');
    expect(await requestAgentUpload({ admin, userId: USER_ID, request, dependencies })).toMatchObject({
      ok: true,
      uploadUrl: `https://project.supabase.test/storage/v1/object/upload/sign/uploads/${USER_ID}/${UPLOAD_ID}-clip.mp4?token=signed-token`,
      kind: 'video',
      maxBytes: 50 * MB,
    });
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(await requestAgentUpload({ admin, userId: USER_ID, request, dependencies })).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    vi.unstubAllEnvs();
  });

  it('holds the declared type and size to the agent caps before anything is signed', async () => {
    const { admin, dependencies } = fakes();
    const ask = (request: { fileName: string; mimeType: string; sizeBytes: number }) => requestAgentUpload({ admin, userId: USER_ID, request, dependencies });
    expect(await ask({ fileName: 'big.png', mimeType: 'image/png', sizeBytes: 25 * MB + 1 }))
      .toMatchObject({ ok: false, code: 'TOO_LARGE', details: { bytes: 25 * MB + 1, max_bytes: 25 * MB } });
    expect(await ask({ fileName: 'big.mp4', mimeType: 'video/mp4', sizeBytes: 50 * MB + 1 }))
      .toMatchObject({ ok: false, code: 'TOO_LARGE', details: { max_bytes: 50 * MB } });
    expect(await ask({ fileName: 'big.mp3', mimeType: 'audio/mpeg', sizeBytes: 50 * MB + 1 }))
      .toMatchObject({ ok: false, code: 'TOO_LARGE', details: { max_bytes: 50 * MB } });
    expect(await ask({ fileName: 'page.html', mimeType: 'text/html', sizeBytes: 10 }))
      .toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'text/html' } });
    expect(await ask({ fileName: 'icon.svg', mimeType: 'image/svg+xml', sizeBytes: 10 })).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });
    expect(dependencies.createTemporaryMediaUploadIntent).not.toHaveBeenCalled();
    // The caps are the URL fetch's own: one set of numbers for an agent to learn.
    expect(AGENT_URL_FETCH_MAX_BYTES_BY_KIND).toEqual({ image: 25 * MB, video: 50 * MB, audio: 50 * MB });

    // At the cap exactly the file is signed; a picker's alias and a type with parameters read as the listed type.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.test');
    expect(await ask({ fileName: 'edge.mp4', mimeType: 'video/mp4', sizeBytes: 50 * MB })).toMatchObject({ ok: true, sizeBytes: 50 * MB });
    expect(await ask({ fileName: 'memo.m4a', mimeType: 'audio/x-m4a', sizeBytes: 10 }))
      .toMatchObject({ ok: true, kind: 'audio', mimeType: 'audio/mp4', headers: { 'content-type': 'audio/mp4' } });
    expect(await ask({ fileName: 'a.png', mimeType: 'IMAGE/PNG; charset=binary', sizeBytes: 10 })).toMatchObject({ ok: true, mimeType: 'image/png' });
    vi.unstubAllEnvs();
  });

  it('maps the sign step\'s refusals: its rate limit with the wait, a deleting account, a name it does not take, and the rest as failures', async () => {
    const ask = (answer: Record<string, unknown>) => {
      const made = fakes({ createTemporaryMediaUploadIntent: vi.fn(async () => ({ ok: false as const, ...answer })) as never });
      return requestAgentUpload({ admin: made.admin, userId: USER_ID, request: { fileName: 'a.png', mimeType: 'image/png', sizeBytes: 10 }, dependencies: made.dependencies });
    };
    expect(await ask({ status: 429, code: 'RATE_LIMITED', error: 'Too many', retryAfterSeconds: 45 })).toMatchObject({ ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 45 });
    expect(await ask({ status: 409, code: 'ACCOUNT_DELETION_IN_PROGRESS', error: 'Deleting.' })).toMatchObject({ ok: false, code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    expect(await ask({ status: 400, error: 'This file type is not supported for media uploads.' }))
      .toEqual({ ok: false, code: 'UNSUPPORTED_MEDIA', message: 'This file type is not supported for media uploads.' });
    expect(await ask({ status: 500, error: 'Failed to prepare media upload.' })).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    // A fifth open upload: the account's staging space is spoken for.
    expect(await ask({ status: 429, code: 'UPLOAD_BYTES_LIMIT', error: 'Too many upload bytes are already reserved. Finish or retry these uploads later.' }))
      .toMatchObject({ ok: false, code: 'UPLOAD_BYTES_LIMIT', details: { open_uploads_max: 4 } });
  });

  it('prints the one command that sends the file: a raw PUT with the three headers, the path left for the agent to fill', () => {
    const headers = { 'content-type': 'image/png', 'x-upsert': 'false' as const, 'cache-control': 'max-age=86400' };
    expect(agentUploadCurlCommand({ uploadUrl: 'https://project.supabase.test/storage/v1/object/upload/sign/uploads/u/x.png?token=abc', headers }))
      .toBe('curl -sS -X PUT -H \'content-type: image/png\' -H \'x-upsert: false\' -H \'cache-control: max-age=86400\' --data-binary @FILE \'https://project.supabase.test/storage/v1/object/upload/sign/uploads/u/x.png?token=abc\'');
    // A quote can never close the word it sits in.
    expect(agentUploadCurlCommand({ uploadUrl: 'https://x.test/a\'b', headers })).toContain('\'https://x.test/a\'\\\'\'b\'');
  });
});

describe('readAgentStagedUploads', () => {
  function reservations(rows: unknown, error: unknown = null) {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      in: vi.fn(async () => ({ data: rows, error })),
    };
    return { admin: { from: vi.fn(() => query) } as unknown as SupabaseClient, query };
  }

  const own = `uploads/${USER_ID}/${UPLOAD_ID}-cat.png`;
  const ownTrack = `uploads/${USER_ID}/66666666-6666-4666-8666-666666666666-memo.m4a`;
  const neverSigned = `uploads/${USER_ID}/never-signed.png`;
  const anothers = `uploads/${OTHER_USER_ID}/${UPLOAD_ID}-theirs.png`;
  const otherBucket = `post_media/${USER_ID}/x.png`;

  it('answers what stands behind each path: a staged upload with its state and stored type, an own path nothing was signed for, or a path that is not the caller\'s', async () => {
    const { admin, query } = reservations([
      { storage_path: `${USER_ID}/${UPLOAD_ID}-cat.png`, finalization_status: 'finalized', actual_content_type: 'image/png', expected_content_type: 'image/png' },
      // Nothing finalized yet: the declared type stands in, read as the lists name it.
      { storage_path: `${USER_ID}/66666666-6666-4666-8666-666666666666-memo.m4a`, finalization_status: 'issued', actual_content_type: null, expected_content_type: 'audio/x-m4a' },
    ]);
    const read = await readAgentStagedUploads(admin, { userId: USER_ID, storagePaths: [own, ownTrack, neverSigned, anothers, otherBucket] });
    expect(read.ok && Object.fromEntries(read.uploads)).toEqual({
      [own]: { kind: 'staged', status: 'finalized', contentType: 'image/png' },
      [ownTrack]: { kind: 'staged', status: 'issued', contentType: 'audio/mp4' },
      [neverSigned]: { kind: 'unknown' },
      [anothers]: { kind: 'foreign' },
      [otherBucket]: { kind: 'foreign' },
    });
    expect(vi.mocked(admin.from)).toHaveBeenCalledWith('upload_byte_reservations');
    expect(query.eq.mock.calls).toEqual([['user_id', USER_ID], ['bucket_id', 'uploads']]);
    // Only the caller's own paths are asked about, bucket-relative as the reservations keep them.
    expect(query.in).toHaveBeenCalledWith('storage_path', [
      `${USER_ID}/${UPLOAD_ID}-cat.png`,
      `${USER_ID}/66666666-6666-4666-8666-666666666666-memo.m4a`,
      `${USER_ID}/never-signed.png`,
    ]);
  });

  it('reads nothing when no path is the caller\'s, and says so when the read fails', async () => {
    const none = reservations([]);
    const read = await readAgentStagedUploads(none.admin, { userId: USER_ID, storagePaths: [anothers, 'not a path'] });
    expect(read.ok && Object.fromEntries(read.uploads)).toEqual({ [anothers]: { kind: 'foreign' }, 'not a path': { kind: 'foreign' } });
    expect(vi.mocked(none.admin.from)).not.toHaveBeenCalled();

    const down = reservations(null, { message: 'down' });
    expect(await readAgentStagedUploads(down.admin, { userId: USER_ID, storagePaths: [own] })).toEqual({ ok: false });
  });
});

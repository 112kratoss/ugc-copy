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
  isUploadStillEmpty,
  readAgentStagedUploads,
  readStoredObjectHead,
  requestAgentUpload,
  stageAgentInput,
  type AgentInputUploadDependencies,
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
    isUploadStillEmpty: vi.fn(async () => false),
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

  it('finalizes the upload for the caller, holds the stored file to the signature rule and answers the same input, with nothing fetched or stored here', async () => {
    const made = fakes({ finalizeUploadById: vi.fn(async () => finalizedAs('image/jpeg', 'cat.jpg')) as never });
    expect(await stage(made)).toEqual({
      ok: true,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-cat.jpg` },
      kind: 'image',
      bytes: 2048,
      mimeType: 'image/jpeg',
      expiresInSeconds: 3600,
      sourceUrl: null,
    });
    // Finalize loads the intent by its id and the caller's own: another account's id is no intent.
    expect(made.dependencies.finalizeUploadById).toHaveBeenCalledTimes(1);
    expect(made.dependencies.finalizeUploadById).toHaveBeenCalledWith(made.admin, { uploadId: UPLOAD_ID, userId: USER_ID });
    expect(made.dependencies.readStoredObjectHead).toHaveBeenCalledWith(made.admin, { bucket: 'uploads', path: `${USER_ID}/${UPLOAD_ID}-cat.jpg` });
    expect(made.dependencies.createTemporaryMediaReadUrl).toHaveBeenCalledWith(expect.objectContaining({
      body: { storagePath: `uploads/${USER_ID}/${UPLOAD_ID}-cat.jpg` },
      userId: USER_ID,
    }));
    expect(made.dependencies.fetchPublicHttpsMedia).not.toHaveBeenCalled();
    expect(made.dependencies.createTemporaryMediaUploadIntent).not.toHaveBeenCalled();
    expect(made.upload).not.toHaveBeenCalled();
    expect(made.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('answers an upload nothing was sent to yet as not ready, and leaves it open for the file', async () => {
    const made = fakes({ isUploadStillEmpty: vi.fn(async () => true) });
    const result = await stage(made);
    expect(result).toMatchObject({ ok: false, code: 'NOT_READY', details: { upload_id: UPLOAD_ID } });
    expect(!result.ok && result.message).toMatch(/Nothing is stored for upload .* yet\. Run the command request_upload gave.*call upload_input again/u);
    expect(made.dependencies.isUploadStillEmpty).toHaveBeenCalledWith(made.admin, { uploadId: UPLOAD_ID, userId: USER_ID });
    // Finalize closes an upload it finds empty for good, and the upload keeps its staging space
    // until the reclaim: an early call must not cost the agent the upload, so finalize is not run.
    expect(made.dependencies.finalizeUploadById).not.toHaveBeenCalled();
    expect(made.dependencies.readStoredObjectHead).not.toHaveBeenCalled();
    expect(made.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('answers an unknown id, another account\'s, a closed upload and one already used with a clear code, touching nothing', async () => {
    const cases: Array<[{ status: number; code: string; error: string }, string, RegExp]> = [
      // No intent under this id for the caller: an unknown id, and another account's, answer alike.
      [{ status: 404, code: 'UPLOAD_NOT_FOUND', error: 'Upload intent not found.' }, 'NOT_FOUND', /No upload .* exists for this creator\. request_upload gives an upload_id/u],
      // Closed earlier (refused, or removed), or its file vanished: the agent starts again.
      [{ status: 400, code: 'UPLOAD_NOT_FOUND', error: 'The uploaded object was not found.' }, 'NOT_FOUND', /holds no file and is closed.*Call request_upload again/u],
      [{ status: 400, code: 'UPLOAD_NOT_FOUND', error: 'That upload is no longer available.' }, 'NOT_FOUND', /holds no file and is closed/u],
      // The stored size or type is not the declared one: finalize removed the file itself.
      [{ status: 400, code: 'UPLOAD_METADATA_MISMATCH', error: 'Uploaded object metadata did not match the server-issued upload intent.' }, 'UNSUPPORTED_MEDIA', /exact size_bytes and mime_type/u],
      [{ status: 409, code: 'UPLOAD_NOT_READY', error: 'That upload was already consumed with a non-reusable disposition.' }, 'CONFLICT', /already used or being collected: That upload was already consumed/u],
      [{ status: 500, code: 'UPLOAD_FINALIZATION_UNAVAILABLE', error: 'Failed to load the upload intent.' }, 'UPLOAD_FAILED', /Failed to load the upload intent/u],
    ];
    for (const [answer, code, words] of cases) {
      const made = fakes({ finalizeUploadById: vi.fn(async () => ({ ok: false as const, ...answer })) as never });
      const result = await stage(made);
      expect(result, answer.error).toMatchObject({ ok: false, code, details: { upload_id: UPLOAD_ID, finalize_code: answer.code } });
      expect(!result.ok && result.message, answer.error).toMatch(words);
      expect(made.dependencies.readStoredObjectHead, answer.error).not.toHaveBeenCalled();
      expect(made.dependencies.createTemporaryMediaReadUrl, answer.error).not.toHaveBeenCalled();
      expect(made.dependencies.deleteReservedObjectAndConfirm, answer.error).not.toHaveBeenCalled();
    }
  });

  it('removes a stored file whose bytes are not what its type says, closes its reservation, and refuses it', async () => {
    // A picture's type over a track's bytes.
    const track = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png')) as never,
      readStoredObjectHead: vi.fn(async () => WAV),
    });
    const refused = await stage(track);
    expect(refused).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { upload_id: UPLOAD_ID, mime_type: 'image/png', sniffed_kind: 'audio' } });
    expect(!refused.ok && refused.message).toContain('request_upload was told image/png, but the file\'s bytes are a track. It was removed');
    expect(track.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledWith(track.admin, 'uploads', `${USER_ID}/${UPLOAD_ID}-cat.png`);
    // With the object gone, finalize runs once more and closes the intent, as it closes one nothing was sent to.
    expect(track.dependencies.finalizeUploadById).toHaveBeenCalledTimes(2);
    expect(track.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();

    // A picture's type over bytes with no picture's signature: a page saved under a picture's name.
    const page = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'page.png')) as never,
      readStoredObjectHead: vi.fn(async () => Buffer.from('<!doctype html><html><body>hello there</body></html>')),
    });
    expect(await stage(page)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { sniffed_kind: null } });
    expect(page.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledTimes(1);

    // A clip's type over a picture's bytes.
    const still = fakes({ finalizeUploadById: vi.fn(async () => finalizedAs('video/mp4', 'clip.mp4')) as never });
    expect(await stage(still)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA', details: { mime_type: 'video/mp4', sniffed_kind: 'image' } });
    expect(still.dependencies.deleteReservedObjectAndConfirm).toHaveBeenCalledTimes(1);

    // A clip with a clip's signature, and a track of a format with no signature, keep their type,
    // as the other two sources keep them.
    const clip = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('video/mp4', 'clip.mp4')) as never,
      readStoredObjectHead: vi.fn(async () => MP4),
    });
    expect(await stage(clip)).toMatchObject({ ok: true, kind: 'video', mimeType: 'video/mp4' });
    const plain = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('audio/aac', 'voice.aac')) as never,
      readStoredObjectHead: vi.fn(async () => Buffer.alloc(64, 7)),
    });
    expect(await stage(plain)).toMatchObject({ ok: true, kind: 'audio' });
    expect(plain.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
  });

  it('removes nothing when the stored file cannot be read, and still refuses a mismatch whose removal fails', async () => {
    const unreadable = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png')) as never,
      readStoredObjectHead: vi.fn(async () => null),
    });
    // The file may be fine: the same call may pass in a moment, so it stays staged.
    expect(await stage(unreadable)).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    expect(unreadable.dependencies.deleteReservedObjectAndConfirm).not.toHaveBeenCalled();
    expect(unreadable.dependencies.finalizeUploadById).toHaveBeenCalledTimes(1);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stuck = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png')) as never,
      readStoredObjectHead: vi.fn(async () => WAV),
      deleteReservedObjectAndConfirm: vi.fn(async () => false),
    });
    expect(await stage(stuck)).toMatchObject({ ok: false, code: 'UNSUPPORTED_MEDIA' });
    // The reservation is not closed over an object that is still there; the reclaim sweep takes it.
    expect(stuck.dependencies.finalizeUploadById).toHaveBeenCalledTimes(1);
    expect(stuck.dependencies.createTemporaryMediaReadUrl).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('takes only an upload staged in the uploads bucket', async () => {
    // A reservation of the creator's in another bucket (a recipe file) is no staged input.
    const elsewhere = fakes({
      finalizeUploadById: vi.fn(async () => finalizedAs('image/png', 'cat.png', { bucket: 'post_resource_files' })) as never,
    });
    expect(await stage(elsewhere)).toMatchObject({ ok: false, code: 'NOT_FOUND', details: { upload_id: UPLOAD_ID } });
    expect(elsewhere.dependencies.readStoredObjectHead).not.toHaveBeenCalled();
  });
});

describe('isUploadStillEmpty', () => {
  function client(row: unknown, info: { data?: unknown; error: unknown }, rowError: unknown = null) {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: row, error: rowError })),
    };
    const objectInfo = vi.fn(async () => info);
    const from = vi.fn(() => ({ info: objectInfo }));
    return { admin: { from: vi.fn(() => query), storage: { from } } as unknown as SupabaseClient, query, from, objectInfo };
  }
  const issued = { bucket_id: 'uploads', storage_path: `${USER_ID}/${UPLOAD_ID}-cat.png`, finalization_status: 'issued' };
  const ask = (made: ReturnType<typeof client>) => isUploadStillEmpty(made.admin, { uploadId: UPLOAD_ID, userId: USER_ID });

  it('is true only for the caller\'s own open upload with nothing stored at its path', async () => {
    const empty = client(issued, { data: null, error: { statusCode: '404', message: 'Object not found' } });
    expect(await ask(empty)).toBe(true);
    // The intent is read by its id and the caller's own, and the object by the path it was signed for.
    expect(vi.mocked(empty.admin.from)).toHaveBeenCalledWith('upload_byte_reservations');
    expect(empty.query.eq.mock.calls).toEqual([['id', UPLOAD_ID], ['user_id', USER_ID]]);
    expect(empty.from).toHaveBeenCalledWith('uploads');
    expect(empty.objectInfo).toHaveBeenCalledWith(`${USER_ID}/${UPLOAD_ID}-cat.png`);
    expect(await ask(client(issued, { data: null, error: { status: 404 } }))).toBe(true);
  });

  it('is false for everything finalize is to answer: a stored file, another state, no such upload, a failed read', async () => {
    // The file arrived.
    expect(await ask(client(issued, { data: { id: 'object-1', size: 10 }, error: null }))).toBe(false);
    // Storage failed for a reason that is not absence.
    expect(await ask(client(issued, { data: null, error: { statusCode: '500', message: 'storage down' } }))).toBe(false);
    // Already finalized, used, or closed: the object is not looked at.
    for (const status of ['finalized', 'consumed', 'deleted', 'reserved']) {
      const other = client({ ...issued, finalization_status: status }, { data: null, error: { statusCode: '404' } });
      expect(await ask(other), status).toBe(false);
      expect(other.objectInfo, status).not.toHaveBeenCalled();
    }
    // An unknown id, or another account's.
    expect(await ask(client(null, { data: null, error: null }))).toBe(false);
    expect(await ask(client(null, { data: null, error: null }, { message: 'down' }))).toBe(false);
    const thrown = client(issued, { data: null, error: null });
    thrown.objectInfo.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await ask(thrown)).toBe(false);
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

import { describe, expect, it, vi } from 'vitest';

import {
  createTemporaryMediaUploadIntent,
  type TemporaryMediaUploadSignClient,
} from '@/lib/temporary-media-upload-sign';

function createClient({
  allowed = true,
  token = 'upload-token',
  signedUrl = 'https://storage.example.test/signed-upload',
  storageError = null as Error | null,
  intentError = null as { message?: string } | null,
} = {}) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'is_account_deletion_requested') return { data: false, error: null };
    if (fn === 'reserve_upload_bytes_v2') return { data: { allowed: true }, error: null };
    if (
      fn === 'mark_upload_byte_reservation_issued'
      || fn === 'abort_upload_byte_reservation_before_issue'
    ) return { data: true, error: null };
    return {
          data: {
            allowed,
            limit: 60,
            remaining: allowed ? 59 : 0,
            retryAfterSeconds: allowed ? 0 : 44,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        };
  });
  const createSignedUploadUrl = vi.fn(async () => ({
    data: storageError ? null : { token, signedUrl },
    error: storageError,
  }));
  const from = vi.fn(() => ({ createSignedUploadUrl }));
  const insert = vi.fn(async () => ({ error: intentError }));
  const tableFrom = vi.fn(() => ({ insert }));

  return {
    client: {
      rpc,
      from: tableFrom,
      storage: { from },
    } satisfies TemporaryMediaUploadSignClient,
    rpc,
    from,
    tableFrom,
    insert,
    createSignedUploadUrl,
  };
}

describe('createTemporaryMediaUploadIntent', () => {
  it('rejects invalid upload metadata before rate-limit and storage work', async () => {
    const clientFactory = vi.fn(() => createClient().client);

    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'image', mimeType: 'image/svg+xml', fileName: 'logo.svg', sizeBytes: 1234 },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Upload a valid image file.',
    });

    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4', sizeBytes: 251 * 1024 * 1024 },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Video uploads must be 250MB or smaller.',
    });

    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'image', mimeType: 'image/bmp', fileName: 'legacy.bmp', sizeBytes: 1234 },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Upload a valid image file.',
    });

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('enforces upload-sign rate limits and creates a sanitized signed upload intent', async () => {
    const client = createClient();

    const result = await createTemporaryMediaUploadIntent({
      body: {
        kind: 'image',
        mimeType: 'image/png',
        fileName: '../Launch Reference?.png',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: client.client,
      createUploadId: () => 'upload-id-1',
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'temporary-media-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 60,
      p_window_seconds: 600,
    });
    expect(client.from).toHaveBeenCalledWith('uploads');
    expect(client.tableFrom).toHaveBeenCalledWith('media_upload_intents');
    expect(client.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      // Bucket-relative, so the sweep can hand it straight to storage.remove().
      storage_path: 'user-1/upload-id-1-launch-reference.png',
      kind: 'image',
      content_type: 'image/png',
      declared_bytes: 1234,
    });
    expect(client.createSignedUploadUrl).toHaveBeenCalledWith('user-1/upload-id-1-launch-reference.png');
    expect(client.insert.mock.invocationCallOrder[0]).toBeLessThan(
      client.createSignedUploadUrl.mock.invocationCallOrder[0] as number,
    );
    expect(client.rpc).toHaveBeenCalledWith('mark_upload_byte_reservation_issued', {
      p_upload_id: 'upload-id-1',
      p_user_id: 'user-1',
      p_token_ttl_seconds: 7200,
    });
    expect(result).toEqual({
      ok: true,
      response: {
        success: true,
        uploadId: 'upload-id-1',
        bucket: 'uploads',
        path: 'user-1/upload-id-1-launch-reference.png',
        storagePath: 'uploads/user-1/upload-id-1-launch-reference.png',
        token: 'upload-token',
        signedUploadUrl: 'https://storage.example.test/signed-upload',
        expiresInSeconds: 7200,
      },
    });
  });

  it('returns stable rate-limit and storage failures', async () => {
    const denied = createClient({ allowed: false });
    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4', sizeBytes: 1234 },
      userId: 'user-1',
      client: denied.client,
      createUploadId: () => 'upload-id-1',
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 44,
    });
    expect(denied.createSignedUploadUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'audio', mimeType: 'audio/mpeg', fileName: 'voice.mp3', sizeBytes: 1234 },
      userId: 'user-1',
      client: storageFailure.client,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'Failed to prepare media upload.',
    });
  });

  it('sanitizes the extension, not just the stem', async () => {
    // Only the stem used to be sanitized, so `clip.mp4 ` produced a key with a
    // trailing space that storage silently dropped -- leaving the recorded path
    // and the real object key as different strings, which the reclaim guard
    // compares by exact value.
    const client = createClient();

    const result = await createTemporaryMediaUploadIntent({
      body: { kind: 'video', mimeType: 'video/mp4', fileName: 'clip.mp4 ', sizeBytes: 1234 },
      userId: 'user-1',
      client: client.client,
      createUploadId: () => 'upload-id-1',
    });

    expect(result).toMatchObject({
      ok: true,
      response: { path: 'user-1/upload-id-1-clip.mp4' },
    });
    expect(client.insert).toHaveBeenCalledWith(expect.objectContaining({
      storage_path: 'user-1/upload-id-1-clip.mp4',
    }));
  });

  it('refuses to hand out a signed URL it could not record', async () => {
    // An unrecorded upload is an object the reclaim sweep can never find, which
    // is the leak this table exists to close. Failing the request is the only
    // outcome that does not create untracked bytes.
    const intentFailure = createClient({ intentError: { message: 'intents table unavailable' } });

    await expect(createTemporaryMediaUploadIntent({
      body: { kind: 'image', mimeType: 'image/png', fileName: 'shot.png', sizeBytes: 1234 },
      userId: 'user-1',
      client: intentFailure.client,
      createUploadId: () => 'upload-id-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'Failed to prepare media upload.',
    });

    expect(intentFailure.createSignedUploadUrl).not.toHaveBeenCalled();
  });
});

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
} = {}) {
  const rpc = vi.fn(async (fn: string) => (
    fn === 'is_account_deletion_requested'
      ? { data: false, error: null }
      : {
          data: {
            allowed,
            limit: 60,
            remaining: allowed ? 59 : 0,
            retryAfterSeconds: allowed ? 0 : 44,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        }
  ));
  const createSignedUploadUrl = vi.fn(async () => ({
    data: storageError ? null : { token, signedUrl },
    error: storageError,
  }));
  const from = vi.fn(() => ({ createSignedUploadUrl }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies TemporaryMediaUploadSignClient,
    rpc,
    from,
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
    expect(client.createSignedUploadUrl).toHaveBeenCalledWith('user-1/upload-id-1-launch-reference.png');
    expect(result).toEqual({
      ok: true,
      response: {
        success: true,
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
});

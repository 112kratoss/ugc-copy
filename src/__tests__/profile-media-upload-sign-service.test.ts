import { describe, expect, it, vi } from 'vitest';

import {
  createProfileMediaUploadIntent,
  type ProfileMediaUploadSignClient,
} from '@/lib/profile-media-upload-sign';

function createClient({
  allowed = true,
  token = 'profile-upload-token',
  signedUrl = 'https://storage.example.test/profile-upload-token',
  publicUrl = 'https://storage.example.test/profiles/user-1/avatar-upload-id-avatar-photo.png',
  storageError = null as Error | null,
  issueMarked = true,
} = {}) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'is_account_deletion_requested') return { data: false, error: null };
    if (fn === 'reserve_upload_bytes_v2') return { data: { allowed: true }, error: null };
    if (
      fn === 'mark_upload_byte_reservation_issued'
    ) return { data: issueMarked, error: null };
    if (fn === 'abort_upload_byte_reservation_before_issue') {
      return { data: true, error: null };
    }
    return {
          data: {
            allowed,
            limit: 30,
            remaining: allowed ? 29 : 0,
            retryAfterSeconds: allowed ? 0 : 45,
            resetAt: '2026-06-22T06:30:00.000Z',
          },
          error: null,
        };
  });
  const createSignedUploadUrl = vi.fn(async () => ({
    data: storageError ? null : { token, signedUrl },
    error: storageError,
  }));
  const getPublicUrl = vi.fn(() => ({
    data: { publicUrl },
  }));
  const from = vi.fn(() => ({ createSignedUploadUrl, getPublicUrl }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies ProfileMediaUploadSignClient,
    createSignedUploadUrl,
    from,
    getPublicUrl,
    rpc,
  };
}

describe('createProfileMediaUploadIntent', () => {
  it('rejects invalid profile media metadata before privileged client work', async () => {
    const clientFactory = vi.fn(() => createClient().client);

    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: 'logo.svg',
        mimeType: 'image/svg+xml',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Upload a valid image file.' },
    });

    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'cover',
        fileName: 'cover.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 6 * 1024 * 1024,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Profile images must be 5MB or smaller.' },
    });

    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: 'legacy.bmp',
        mimeType: 'image/bmp',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: clientFactory,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Upload a valid image file.' },
    });

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('enforces upload-sign limits and creates a sanitized signed upload intent', async () => {
    const client = createClient();

    const result = await createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: '../Avatar Photo.PNG',
        mimeType: 'image/png',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: client.client,
      createUploadId: () => 'upload-id',
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile-media-upload:sign',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(client.from).toHaveBeenCalledWith('profiles');
    expect(client.createSignedUploadUrl).toHaveBeenCalledWith('user-1/avatar-upload-id-avatar-photo.png');
    expect(client.getPublicUrl).toHaveBeenCalledWith('user-1/avatar-upload-id-avatar-photo.png');
    expect(client.getPublicUrl.mock.invocationCallOrder[0]).toBeLessThan(
      client.createSignedUploadUrl.mock.invocationCallOrder[0] as number,
    );
    expect(client.rpc).toHaveBeenCalledWith('mark_upload_byte_reservation_issued', {
      p_upload_id: 'upload-id',
      p_user_id: 'user-1',
      p_token_ttl_seconds: 7200,
    });
    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        uploadId: 'upload-id',
        bucket: 'profiles',
        path: 'user-1/avatar-upload-id-avatar-photo.png',
        token: 'profile-upload-token',
        signedUploadUrl: 'https://storage.example.test/profile-upload-token',
        publicUrl: 'https://storage.example.test/profiles/user-1/avatar-upload-id-avatar-photo.png',
        expiresInSeconds: 7200,
      },
    });
  });

  it('returns stable rate-limit, storage, and public-url failures', async () => {
    const denied = createClient({ allowed: false });
    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'cover',
        fileName: 'cover.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: denied.client,
      createUploadId: () => 'upload-id',
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 45,
      },
    });
    expect(denied.createSignedUploadUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: 'avatar.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: storageFailure.client,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare profile media upload.' },
    });
    expect(storageFailure.rpc).toHaveBeenCalledWith('abort_upload_byte_reservation_before_issue', {
      p_upload_id: 'upload-id',
      p_user_id: 'user-1',
    });

    const missingPublicUrl = createClient({ publicUrl: '' });
    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: 'avatar.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: missingPublicUrl.client,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare profile media URL.' },
    });
    expect(missingPublicUrl.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(missingPublicUrl.rpc).toHaveBeenCalledWith('abort_upload_byte_reservation_before_issue', {
      p_upload_id: 'upload-id',
      p_user_id: 'user-1',
    });

    const issuanceFailure = createClient({ issueMarked: false });
    await expect(createProfileMediaUploadIntent({
      body: {
        role: 'avatar',
        fileName: 'avatar.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
      },
      userId: 'user-1',
      client: issuanceFailure.client,
      createUploadId: () => 'upload-id',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to activate profile media upload.' },
    });
    expect(issuanceFailure.createSignedUploadUrl).toHaveBeenCalled();
    expect(issuanceFailure.rpc).not.toHaveBeenCalledWith(
      'abort_upload_byte_reservation_before_issue',
      expect.anything(),
    );
  });
});
